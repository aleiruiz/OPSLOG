import 'reflect-metadata';
import { createHash, randomUUID } from 'node:crypto';
import { type DataSource, type EntityManager } from 'typeorm';
import type {
  MaintenancePlan,
  OdometerReading,
  PlanEvaluation,
  PlanScanStore,
  PreventiveOrderClosedEvent,
} from '../../../../domain/maintenance/plans/src/index.js';
import {
  MaintenancePlanError,
  evaluatePlan,
  isValidDateOnly,
  targets,
} from '../../../../domain/maintenance/plans/src/index.js';
import { MAINTENANCE_RUNTIME_ACCOUNT } from './data-source.js';
import {
  MaintenanceAlertSchema,
  MaintenanceOccurrenceEntity,
  MaintenanceOrderSchema,
  MaintenancePlanEntity,
  MaintenancePlanVersionEntity,
} from './entities.js';
import { MySqlTenantOutboxStore } from '../../../audit/src/index.js';
import { appendMaintenanceAudit } from './audit.js';

function fromRow(row: MaintenancePlanEntity): MaintenancePlan {
  return {
    id: row.id,
    tenantId: row.tenantId,
    vehicleId: row.vehicleId,
    state: row.state as MaintenancePlan['state'],
    ...(row.intervalDays === null ? {} : { intervalDays: row.intervalDays }),
    ...(row.intervalKm === null ? {} : { intervalKm: row.intervalKm }),
    ...(row.lastServiceDate === null ? {} : { lastServiceDate: row.lastServiceDate }),
    ...(row.lastServiceKm === null ? {} : { lastServiceKm: row.lastServiceKm }),
    defaultWorkshopId: row.defaultWorkshopId,
    defaultMechanicId: row.defaultMechanicId,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
function toRow(value: MaintenancePlan): Partial<MaintenancePlanEntity> {
  return {
    tenantId: value.tenantId,
    id: value.id,
    vehicleId: value.vehicleId,
    state: value.state,
    intervalDays: value.intervalDays ?? null,
    intervalKm: value.intervalKm ?? null,
    lastServiceDate: value.lastServiceDate ?? null,
    lastServiceKm: value.lastServiceKm ?? null,
    defaultWorkshopId: value.defaultWorkshopId ?? null,
    defaultMechanicId: value.defaultMechanicId ?? null,
    version: value.version,
    createdAt: new Date(value.createdAt),
    updatedAt: new Date(value.updatedAt),
  };
}

export class TypeOrmMaintenancePlanWorkerStore implements PlanScanStore {
  private readonly outbox: MySqlTenantOutboxStore;
  public constructor(
    private readonly dataSource: DataSource,
    private readonly maxAttempts = 3,
  ) {
    if (dataSource.options.type !== 'mysql' || dataSource.options.synchronize === true)
      throw new Error('Maintenance plan worker store requires MySQL with synchronize disabled');
    if (
      typeof dataSource.options.username !== 'string' ||
      !MAINTENANCE_RUNTIME_ACCOUNT.test(dataSource.options.username)
    )
      throw new Error('Maintenance plan worker store requires its restricted runtime account');
    this.outbox = new MySqlTenantOutboxStore(
      () => [],
      () => this.dataSource,
      () => this.dataSource,
    );
  }
  private async transaction<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.dataSource.transaction('READ COMMITTED', work);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (
          attempt < this.maxAttempts &&
          (code === 'ER_LOCK_DEADLOCK' || code === 'ER_LOCK_WAIT_TIMEOUT')
        )
          continue;
        throw error;
      }
    }
  }
  private digest(value: string): string {
    return createHash('sha256').update(value).digest('hex').slice(0, 32);
  }
  private async persistAlert(
    manager: EntityManager,
    tenantId: string,
    plan: MaintenancePlan,
    evaluation: PlanEvaluation,
    occurrenceId: string | null,
  ): Promise<void> {
    const naturalKey = [
      tenantId,
      plan.id,
      String(evaluation.occurrence),
      String(evaluation.planVersion),
      evaluation.kind,
      evaluation.trigger,
      evaluation.threshold,
    ].join('|');
    const idempotencyKey = `maintenance:${this.digest(naturalKey)}`;
    const alerts = manager.getRepository(MaintenanceAlertSchema);
    if (await alerts.findOneBy({ tenantId, idempotencyKey })) return;
    const alertId = randomUUID();
    await alerts.insert({
      tenantId,
      id: alertId,
      planId: plan.id,
      occurrence: evaluation.occurrence,
      planVersion: evaluation.planVersion,
      kind: evaluation.kind,
      trigger: evaluation.trigger,
      threshold: evaluation.threshold,
      targetDate: evaluation.targetDate,
      targetKm: evaluation.targetKm,
      odometerLastUpdatedAt: evaluation.odometerLastUpdatedAt
        ? new Date(evaluation.odometerLastUpdatedAt)
        : null,
      odometerAgeSeconds: evaluation.odometerAgeSeconds ?? null,
      occurredAt: new Date(evaluation.occurredAt),
      idempotencyKey,
    });
    const eventId = `maintenance-${this.digest(naturalKey)}`;
    await this.outbox.transaction(manager, (tx) =>
      tx.enqueue({
        tenantId,
        eventId,
        type: 'maintenance.plan.alert',
        payload: {
          alertId,
          planId: plan.id,
          ...(occurrenceId === null ? {} : { occurrenceId }),
          eventType: evaluation.kind,
          schemaVersion: 1,
        },
        occurredAt: evaluation.occurredAt,
        idempotencyKey,
        correlationId: eventId,
        actorRef: { subject: 'worker-maintenance-plans', kind: 'system' },
        requiredPermission: 'view',
        entityId: plan.id,
        schemaVersion: 1,
      }),
    );
    await appendMaintenanceAudit(manager, {
      tenantId,
      entityType: 'maintenance_plan',
      entityId: plan.id,
      actorId: 'worker-maintenance-plans',
      actorKind: 'system',
      action: 'maintenance.plan.alerted',
      occurredAt: evaluation.occurredAt,
      revision: naturalKey,
    });
  }

  /** Locks the plan row so independent workers serialize, then commits occurrence, scheduled order, alert and outbox together. */
  public async scan(
    tenantId: string,
    planId: string,
    now: Date,
    odometer: OdometerReading,
  ): Promise<readonly PlanEvaluation[]> {
    return this.transaction(async (manager) => {
      const plans = manager.getRepository(MaintenancePlanEntity);
      const row = await plans.findOne({
        where: { tenantId, id: planId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!row) throw new MaintenancePlanError('not_found');
      const plan = fromRow(row);
      if (plan.state !== 'active') return [];
      const occurrences = manager.getRepository(MaintenanceOccurrenceEntity);
      const latest = await occurrences.findOne({
        where: { tenantId, planId },
        order: { sequence: 'DESC' },
      });
      if (latest && latest.state !== 'completed' && latest.state !== 'closed') {
        const currentTargets = { targetDate: latest.targetDate, targetKm: latest.targetKm };
        const today = now.toISOString().slice(0, 10);
        const passed =
          latest.trigger === 'date'
            ? currentTargets.targetDate !== null && today > currentTargets.targetDate
            : odometer.updatedAt !== null &&
              currentTargets.targetKm !== null &&
              odometer.km > currentTargets.targetKm;
        if (!passed) return [];
        const overdue: PlanEvaluation = {
          kind: 'overdue',
          trigger: latest.trigger as PlanEvaluation['trigger'],
          threshold: 'target',
          occurrence: latest.sequence,
          planVersion: latest.planVersion,
          ...currentTargets,
          occurredAt: now.toISOString(),
          ...(latest.trigger === 'odometer' && odometer.updatedAt !== null
            ? {
                odometerLastUpdatedAt: odometer.updatedAt,
                odometerAgeSeconds: Math.max(
                  0,
                  Math.floor((now.getTime() - Date.parse(odometer.updatedAt)) / 1000),
                ),
              }
            : {}),
        };
        await this.persistAlert(manager, tenantId, plan, overdue, latest.id);
        return [overdue];
      }
      const sequence = (latest?.sequence ?? 0) + 1;
      const { targetDate, targetKm } = targets(plan);
      const dateReached = targetDate !== null && now.toISOString().slice(0, 10) >= targetDate;
      const kmReached = odometer.updatedAt !== null && targetKm !== null && odometer.km >= targetKm;
      const odometerReachedAt =
        kmReached && odometer.updatedAt !== null ? Date.parse(odometer.updatedAt) : Number.NaN;
      const dateTargetAt = targetDate === null ? Number.NaN : Date.parse(`${targetDate}T00:00:00.000Z`);
      const trigger =
        dateReached && kmReached
          ? odometerReachedAt < dateTargetAt
            ? 'odometer'
            : 'date'
          : dateReached
            ? 'date'
            : 'odometer';
      let evaluations: readonly PlanEvaluation[];
      if (dateReached || kmReached) {
        const due: PlanEvaluation = {
          kind: 'due',
          trigger,
          threshold: 'target',
          occurrence: sequence,
          planVersion: plan.version,
          targetDate,
          targetKm,
          occurredAt: now.toISOString(),
          ...(trigger === 'odometer' && odometer.updatedAt !== null
            ? {
                odometerLastUpdatedAt: odometer.updatedAt,
                odometerAgeSeconds: Math.max(
                  0,
                  Math.floor((now.getTime() - Date.parse(odometer.updatedAt)) / 1000),
                ),
              }
            : {}),
        };
        const targetPassed =
          trigger === 'date'
            ? targetDate !== null && now.toISOString().slice(0, 10) > targetDate
            : targetKm !== null && odometer.km > targetKm;
        const overdue: PlanEvaluation = { ...due, kind: 'overdue' };
        evaluations = targetPassed ? [due, overdue] : [due];
        const occurrenceId = randomUUID();
        const orderId = randomUUID();
        const idempotencyKey = `occurrence:${this.digest(`${tenantId}|${planId}|${sequence}`)}`;
        await occurrences.insert({
          tenantId,
          id: occurrenceId,
          planId,
          sequence,
          planVersion: plan.version,
          trigger,
          targetDate,
          targetKm,
          detectedAt: now,
          idempotencyKey,
          orderId,
          state: 'scheduled',
          workshopId: plan.defaultWorkshopId ?? null,
          mechanicId: plan.defaultMechanicId ?? null,
          completedAt: null,
          actualDate: null,
          actualKm: null,
        });
        await manager.getRepository(MaintenanceOrderSchema).insert({
          tenantId,
          id: orderId,
          occurrenceId,
          planId,
          vehicleId: plan.vehicleId,
          status: 'scheduled',
          kind: 'preventive',
          snapshot: {
            planVersion: plan.version,
            targetDate,
            targetKm,
            trigger,
            workshopId: plan.defaultWorkshopId ?? null,
            mechanicId: plan.defaultMechanicId ?? null,
          },
          createdAt: now,
        });
        for (const evaluation of evaluations)
          await this.persistAlert(manager, tenantId, plan, evaluation, occurrenceId);
      } else {
        // Use the domain evaluator for exact inclusive UTC date/km windows.
        evaluations = evaluatePlan(plan, { now, odometer, occurrence: sequence });
        for (const evaluation of evaluations)
          await this.persistAlert(manager, tenantId, plan, evaluation, null);
      }
      return evaluations;
    });
  }

  public async closePreventive(event: PreventiveOrderClosedEvent): Promise<void> {
    if (event.kind === 'corrective') return;
    if (
      !isValidDateOnly(event.actualDate) ||
      !Number.isInteger(event.actualKm) ||
      event.actualKm < 0 ||
      Number.isNaN(Date.parse(event.completedAt))
    )
      throw new MaintenancePlanError('invalid_input');
    await this.transaction(async (manager) => {
      const planRepo = manager.getRepository(MaintenancePlanEntity);
      const planRow = await planRepo.findOne({
        where: { tenantId: event.tenantId, id: event.planId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!planRow) throw new MaintenancePlanError('not_found');
      const occurrenceRepo = manager.getRepository(MaintenanceOccurrenceEntity);
      const occurrence = await occurrenceRepo.findOne({
        where: {
          tenantId: event.tenantId,
          id: event.occurrenceId,
          planId: event.planId,
          orderId: event.orderId,
        },
        lock: { mode: 'pessimistic_write' },
      });
      if (!occurrence) throw new MaintenancePlanError('not_found');
      if (occurrence.state === 'completed' || occurrence.state === 'closed') return;
      const plan = fromRow(planRow);
      if (plan.lastServiceKm !== undefined && event.actualKm < plan.lastServiceKm)
        throw new MaintenancePlanError('odometer_decrease');
      const completedAt = new Date(event.completedAt);
      await occurrenceRepo.update(
        { tenantId: event.tenantId, id: occurrence.id, state: occurrence.state },
        { state: 'completed', completedAt, actualDate: event.actualDate, actualKm: event.actualKm },
      );
      await manager
        .getRepository(MaintenanceOrderSchema)
        .update(
          { tenantId: event.tenantId, id: event.orderId, occurrenceId: occurrence.id },
          { status: 'completed' },
        );
      const next: MaintenancePlan = {
        ...plan,
        lastServiceDate: event.actualDate,
        lastServiceKm: event.actualKm,
        version: plan.version + 1,
        updatedAt: completedAt.toISOString(),
      };
      const changed = await planRepo.update(
        { tenantId: event.tenantId, id: event.planId, version: plan.version },
        toRow(next),
      );
      if (changed.affected !== 1) throw new MaintenancePlanError('stale_version');
      await manager.getRepository(MaintenancePlanVersionEntity).insert({
        tenantId: event.tenantId,
        planId: event.planId,
        version: next.version,
        snapshot: next,
        actorId: 'worker-maintenance-plans',
        createdAt: completedAt,
      });
      await appendMaintenanceAudit(manager, {
        tenantId: event.tenantId,
        entityType: 'maintenance_plan',
        entityId: event.planId,
        actorId: 'worker-maintenance-plans',
        actorKind: 'system',
        action: 'maintenance.plan.advanced',
        occurredAt: next.updatedAt,
        revision: String(next.version),
      });
    });
  }
}
