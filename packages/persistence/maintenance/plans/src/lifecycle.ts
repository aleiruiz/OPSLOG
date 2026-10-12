import 'reflect-metadata';
import { IsNull, type EntityManager } from 'typeorm';
import type {
  MaintenancePlan,
  PreventiveOrderClosedEvent,
  PreventiveOrderLifecycleEvent,
} from '../../../../domain/maintenance/plans/src/index.js';
import {
  MaintenancePlanError,
  isValidDateOnly,
} from '../../../../domain/maintenance/plans/src/index.js';
import { appendMaintenanceAudit } from './audit.js';
import {
  MaintenanceOccurrenceEntity,
  MaintenanceOrderSchema,
  MaintenancePlanEntity,
  MaintenancePlanVersionEntity,
} from './entities.js';
import { fromRow, toRow } from './plan-mapping.js';

const ACTOR = 'worker-maintenance-plans';
const APPLIED: readonly string[] = ['completed', 'closed'];

interface Locked {
  readonly plan: MaintenancePlan;
  readonly occurrence: MaintenanceOccurrenceEntity;
}

/** Locks plan then occurrence (same order as scan) so every lifecycle event serializes per plan. */
async function lock(
  manager: EntityManager,
  event: Pick<PreventiveOrderLifecycleEvent, 'tenantId' | 'planId' | 'occurrenceId' | 'orderId'>,
): Promise<Locked> {
  const planRow = await manager.getRepository(MaintenancePlanEntity).findOne({
    where: { tenantId: event.tenantId, id: event.planId },
    lock: { mode: 'pessimistic_write' },
  });
  if (!planRow) throw new MaintenancePlanError('not_found');
  const occurrence = await manager.getRepository(MaintenanceOccurrenceEntity).findOne({
    where: {
      tenantId: event.tenantId,
      id: event.occurrenceId,
      planId: event.planId,
      orderId: event.orderId,
    },
    lock: { mode: 'pessimistic_write' },
  });
  if (!occurrence) throw new MaintenancePlanError('not_found');
  return { plan: fromRow(planRow), occurrence };
}

async function setOrderStatus(
  manager: EntityManager,
  occurrence: MaintenanceOccurrenceEntity,
  status: string,
): Promise<void> {
  await manager
    .getRepository(MaintenanceOrderSchema)
    .update(
      { tenantId: occurrence.tenantId, id: occurrence.orderId, occurrenceId: occurrence.id },
      { status },
    );
}

async function writePlan(
  manager: EntityManager,
  current: MaintenancePlan,
  next: MaintenancePlan,
  action: string,
): Promise<void> {
  const changed = await manager
    .getRepository(MaintenancePlanEntity)
    .update({ tenantId: current.tenantId, id: current.id, version: current.version }, toRow(next));
  if (changed.affected !== 1) throw new MaintenancePlanError('stale_version');
  await manager.getRepository(MaintenancePlanVersionEntity).insert({
    tenantId: current.tenantId,
    planId: current.id,
    version: next.version,
    snapshot: next,
    actorId: ACTOR,
    createdAt: new Date(next.updatedAt),
  });
  await appendMaintenanceAudit(manager, {
    tenantId: current.tenantId,
    entityType: 'maintenance_plan',
    entityId: current.id,
    actorId: ACTOR,
    actorKind: 'system',
    action,
    occurredAt: next.updatedAt,
    revision: String(next.version),
  });
}

/** The baseline as it was before the occurrence's closure, when no later plan change exists. */
async function priorBaseline(
  manager: EntityManager,
  plan: MaintenancePlan,
  occurrence: MaintenanceOccurrenceEntity,
): Promise<MaintenancePlan | null> {
  if (
    !APPLIED.includes(occurrence.state) ||
    occurrence.closurePlanVersion === null ||
    plan.version !== occurrence.closurePlanVersion
  )
    return null;
  const prior = await manager.getRepository(MaintenancePlanVersionEntity).findOneBy({
    tenantId: plan.tenantId,
    planId: plan.id,
    version: occurrence.closurePlanVersion - 1,
  });
  return (prior?.snapshot as MaintenancePlan | undefined) ?? null;
}

export async function baselineBeforeClosure(
  manager: EntityManager,
  tenantId: string,
  planId: string,
  occurrenceId: string,
): Promise<{ lastServiceDate: string | null; lastServiceKm: number | null } | null> {
  const planRow = await manager
    .getRepository(MaintenancePlanEntity)
    .findOneBy({ tenantId, id: planId });
  if (!planRow) return null;
  const plan = fromRow(planRow);
  const occurrence = await manager
    .getRepository(MaintenanceOccurrenceEntity)
    .findOneBy({ tenantId, planId, id: occurrenceId });
  const prior = occurrence ? await priorBaseline(manager, plan, occurrence) : null;
  const source = prior ?? plan;
  return {
    lastServiceDate: source.lastServiceDate ?? null,
    lastServiceKm: source.lastServiceKm ?? null,
  };
}

/**
 * Undoes an applied closure: restores the baseline snapshotted before it (only while the plan has
 * not changed since) and supersedes successors that are still only scheduled. Adopted successors
 * stay: work already in progress is never discarded.
 */
async function rollback(
  manager: EntityManager,
  { plan, occurrence }: Locked,
  at: Date,
): Promise<void> {
  const prior = await priorBaseline(manager, plan, occurrence);
  if (prior) {
    const rest = Object.fromEntries(
      Object.entries(plan).filter(([key]) => key !== 'lastServiceDate' && key !== 'lastServiceKm'),
    ) as Omit<MaintenancePlan, 'lastServiceDate' | 'lastServiceKm'>;
    await writePlan(
      manager,
      plan,
      {
        ...rest,
        ...(prior.lastServiceDate === undefined ? {} : { lastServiceDate: prior.lastServiceDate }),
        ...(prior.lastServiceKm === undefined ? {} : { lastServiceKm: prior.lastServiceKm }),
        version: plan.version + 1,
        updatedAt: at.toISOString(),
      },
      'maintenance.plan.reverted',
    );
  }
  const repo = manager.getRepository(MaintenanceOccurrenceEntity);
  const successors = await repo.find({
    where: {
      tenantId: occurrence.tenantId,
      planId: occurrence.planId,
      state: 'scheduled',
      adoptedAt: IsNull(),
    },
    lock: { mode: 'pessimistic_write' },
  });
  for (const successor of successors.filter((item) => item.sequence > occurrence.sequence)) {
    await repo.update({ tenantId: successor.tenantId, id: successor.id }, { state: 'cancelled' });
    await setOrderStatus(manager, successor, 'cancelled');
  }
}

const CLEARED = { completedAt: null, actualDate: null, actualKm: null, closurePlanVersion: null };

async function audit(
  manager: EntityManager,
  event: PreventiveOrderLifecycleEvent,
  action: string,
  at: Date,
): Promise<void> {
  await appendMaintenanceAudit(manager, {
    tenantId: event.tenantId,
    entityType: 'maintenance_plan',
    entityId: event.planId,
    actorId: ACTOR,
    actorKind: 'system',
    action,
    occurredAt: at.toISOString(),
    revision: `${event.occurrenceId}|${event.version}`,
  });
}

/** Applies a (re)closure once per order version; a newer close replaces an earlier applied one. */
export async function applyClosure(
  manager: EntityManager,
  event: PreventiveOrderClosedEvent,
): Promise<void> {
  if (
    !isValidDateOnly(event.actualDate) ||
    !Number.isInteger(event.actualKm) ||
    event.actualKm < 0 ||
    Number.isNaN(Date.parse(event.completedAt))
  )
    throw new MaintenancePlanError('invalid_input');
  const locked = await lock(manager, event);
  const { occurrence } = locked;
  let { plan } = locked;
  const applied = APPLIED.includes(occurrence.state);
  if (event.version === undefined ? applied : occurrence.appliedVersion >= event.version) return;
  const completedAt = new Date(event.completedAt);
  if (applied) {
    await rollback(manager, locked, completedAt);
    plan = fromRow(
      await manager
        .getRepository(MaintenancePlanEntity)
        .findOneByOrFail({ tenantId: event.tenantId, id: event.planId }),
    );
  }
  // The baseline never moves backwards (L3): a plan edit after completion wins over the closure.
  const lastServiceDate =
    plan.lastServiceDate === undefined || event.actualDate > plan.lastServiceDate
      ? event.actualDate
      : plan.lastServiceDate;
  const lastServiceKm =
    plan.lastServiceKm === undefined || event.actualKm > plan.lastServiceKm
      ? event.actualKm
      : plan.lastServiceKm;
  const advances = lastServiceDate !== plan.lastServiceDate || lastServiceKm !== plan.lastServiceKm;
  await manager.getRepository(MaintenanceOccurrenceEntity).update(
    { tenantId: event.tenantId, id: occurrence.id },
    {
      state: 'completed',
      completedAt,
      actualDate: event.actualDate,
      actualKm: event.actualKm,
      appliedVersion: event.version ?? occurrence.appliedVersion,
      closurePlanVersion: advances ? plan.version + 1 : null,
    },
  );
  await setOrderStatus(manager, occurrence, 'completed');
  if (advances)
    await writePlan(
      manager,
      plan,
      {
        ...plan,
        lastServiceDate,
        lastServiceKm,
        version: plan.version + 1,
        updatedAt: completedAt.toISOString(),
      },
      'maintenance.plan.advanced',
    );
  else
    await audit(
      manager,
      { ...event, version: event.version ?? occurrence.appliedVersion },
      'maintenance.occurrence.completed_without_advance',
      completedAt,
    );
}

/** Reopen: invalidates the closure and restores the pre-closure baseline; re-close applies the corrected values. */
export async function applyReopen(
  manager: EntityManager,
  event: PreventiveOrderLifecycleEvent,
): Promise<void> {
  const locked = await lock(manager, event);
  const { occurrence } = locked;
  if (occurrence.appliedVersion >= event.version) return;
  const at = new Date();
  const repo = manager.getRepository(MaintenanceOccurrenceEntity);
  if (APPLIED.includes(occurrence.state)) {
    await rollback(manager, locked, at);
    await repo.update(
      { tenantId: event.tenantId, id: occurrence.id },
      { ...CLEARED, state: 'scheduled', appliedVersion: event.version },
    );
    await setOrderStatus(manager, occurrence, 'scheduled');
    await audit(manager, event, 'maintenance.occurrence.reopened', at);
  } else
    await repo.update(
      { tenantId: event.tenantId, id: occurrence.id },
      { appliedVersion: event.version },
    );
}

/** Cancel: keeps the occurrence as history; the next scan schedules the still pending maintenance. */
export async function applyCancel(
  manager: EntityManager,
  event: PreventiveOrderLifecycleEvent,
): Promise<void> {
  const locked = await lock(manager, event);
  const { occurrence } = locked;
  if (occurrence.appliedVersion >= event.version) return;
  const at = new Date();
  if (APPLIED.includes(occurrence.state)) await rollback(manager, locked, at);
  await manager
    .getRepository(MaintenanceOccurrenceEntity)
    .update(
      { tenantId: event.tenantId, id: occurrence.id },
      { ...CLEARED, state: 'cancelled', appliedVersion: event.version },
    );
  await setOrderStatus(manager, occurrence, 'cancelled');
  await audit(manager, event, 'maintenance.occurrence.cancelled', at);
}

export async function applyAdopted(
  manager: EntityManager,
  event: PreventiveOrderLifecycleEvent,
): Promise<void> {
  const { occurrence } = await lock(manager, event);
  if (occurrence.adoptedAt !== null) return;
  await manager
    .getRepository(MaintenanceOccurrenceEntity)
    .update({ tenantId: event.tenantId, id: occurrence.id }, { adoptedAt: new Date() });
}
