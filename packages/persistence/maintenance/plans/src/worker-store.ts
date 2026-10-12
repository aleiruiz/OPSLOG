import 'reflect-metadata';
import { createHash, randomUUID } from 'node:crypto';
import { type DataSource, type EntityManager } from 'typeorm';
import type {
  MaintenancePlan,
  OdometerReading,
  PlanEvaluation,
  PlanScanStore,
  PreventiveOrderClosedEvent,
  PreventiveOrderLifecycleEvent,
} from '../../../../domain/maintenance/plans/src/index.js';
import {
  MaintenancePlanError,
  calendarDay,
  evaluatePlan,
  targets,
} from '../../../../domain/maintenance/plans/src/index.js';
import { MAINTENANCE_RUNTIME_ACCOUNT } from './data-source.js';
import {
  MaintenanceAlertSchema,
  MaintenanceOccurrenceEntity,
  MaintenanceOrderSchema,
  MaintenancePlanEntity,
} from './entities.js';
import { MySqlTenantOutboxStore } from '../../../audit/src/index.js';
import { appendMaintenanceAudit } from './audit.js';
import { fromRow } from './plan-mapping.js';
import {
  applyAdopted,
  applyCancel,
  applyClosure,
  applyReopen,
  baselineBeforeClosure,
} from './lifecycle.js';

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
    timeZone = 'UTC',
  ): Promise<readonly PlanEvaluation[]> {
    // Calendar days (target dates, "today") are the tenant's, not UTC's (SPECS:184).
    const today = calendarDay(now, timeZone);
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
      const last = await occurrences.findOne({
        where: { tenantId, planId },
        order: { sequence: 'DESC' },
      });
      // A completed, closed or cancelled occurrence frees the plan: only a scheduled one blocks it.
      const latest = await occurrences.findOne({
        where: { tenantId, planId, state: 'scheduled' },
        order: { sequence: 'DESC' },
      });
      if (latest) {
        const currentTargets = { targetDate: latest.targetDate, targetKm: latest.targetKm };
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
      const sequence = (last?.sequence ?? 0) + 1;
      const { targetDate, targetKm } = targets(plan);
      const dateReached = targetDate !== null && today >= targetDate;
      const kmReached = odometer.updatedAt !== null && targetKm !== null && odometer.km >= targetKm;
      const odometerReachedAt =
        kmReached && odometer.updatedAt !== null ? Date.parse(odometer.updatedAt) : Number.NaN;
      const dateTargetAt =
        targetDate === null ? Number.NaN : Date.parse(`${targetDate}T00:00:00.000Z`);
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
            ? targetDate !== null && today > targetDate
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
        evaluations = evaluatePlan(plan, { now, odometer, occurrence: sequence, timeZone });
        for (const evaluation of evaluations)
          await this.persistAlert(manager, tenantId, plan, evaluation, null);
      }
      return evaluations;
    });
  }

  public closePreventive(event: PreventiveOrderClosedEvent): Promise<void> {
    if (event.kind === 'corrective') return Promise.resolve();
    return this.transaction((manager) => applyClosure(manager, event));
  }
  public reopenPreventive(event: PreventiveOrderLifecycleEvent): Promise<void> {
    return this.transaction((manager) => applyReopen(manager, event));
  }
  public cancelPreventive(event: PreventiveOrderLifecycleEvent): Promise<void> {
    return this.transaction((manager) => applyCancel(manager, event));
  }
  public adoptPreventive(event: PreventiveOrderLifecycleEvent): Promise<void> {
    return this.transaction((manager) => applyAdopted(manager, event));
  }
  public baselineBeforeClosure(tenantId: string, planId: string, occurrenceId: string) {
    return baselineBeforeClosure(this.dataSource.manager, tenantId, planId, occurrenceId);
  }
}
