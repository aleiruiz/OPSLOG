import 'reflect-metadata';
import { type DataSource, type EntityManager } from 'typeorm';
import type {
  MaintenancePlan,
  MaintenancePlanSchedule,
  PlanAlertPage,
  PlanAlertQuery,
  PlanAlertReader,
  PlanEvaluation,
  PlanOccurrence,
  PlanScanStore,
  PlanScheduleReader,
  PlanStore,
  OdometerReading,
  PreventiveOrderClosedEvent,
  PreventiveOrderLifecycleEvent,
  ScheduledMaintenanceOrder,
} from '../../../../domain/maintenance/plans/src/index.js';
import { MaintenancePlanError, targets } from '../../../../domain/maintenance/plans/src/index.js';
import { MAINTENANCE_RUNTIME_ACCOUNT } from './data-source.js';
import {
  MaintenanceOccurrenceEntity,
  MaintenanceOrderSchema,
  MaintenancePlanEntity,
  MaintenancePlanVersionEntity,
} from './entities.js';
import { appendMaintenanceAudit } from './audit.js';
import { listPlanAlerts } from './alert-reader.js';
import { fromRow, toRow } from './plan-mapping.js';
import { TypeOrmMaintenancePlanWorkerStore } from './worker-store.js';

export interface TypeOrmMaintenancePlanStoreOptions {
  readonly maxAttempts?: number;
}
/** Tenant is part of every selector. Plan snapshots are append-only and changes use version CAS. */
export class TypeOrmMaintenancePlanStore
  implements PlanStore, PlanScanStore, PlanScheduleReader, PlanAlertReader
{
  private readonly workerStore: TypeOrmMaintenancePlanWorkerStore;
  private readonly maxAttempts: number;
  public constructor(
    private readonly dataSource: DataSource,
    options: TypeOrmMaintenancePlanStoreOptions = {},
  ) {
    if (dataSource.options.type !== 'mysql' || dataSource.options.synchronize === true)
      throw new Error('Maintenance plan store requires MySQL with synchronize disabled');
    if (
      typeof dataSource.options.username !== 'string' ||
      !MAINTENANCE_RUNTIME_ACCOUNT.test(dataSource.options.username)
    )
      throw new Error('Maintenance plan store requires its restricted runtime account');
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.workerStore = new TypeOrmMaintenancePlanWorkerStore(dataSource, this.maxAttempts);
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
  public async create(plan: MaintenancePlan, actorId: string): Promise<MaintenancePlan> {
    try {
      await this.transaction(async (manager) => {
        await manager.getRepository(MaintenancePlanEntity).insert(toRow(plan));
        await manager.getRepository(MaintenancePlanVersionEntity).insert({
          tenantId: plan.tenantId,
          planId: plan.id,
          version: plan.version,
          snapshot: plan,
          actorId,
          createdAt: new Date(plan.createdAt),
        });
        await this.audit(manager, plan, actorId, 'maintenance.plan.created');
      });
      return plan;
    } catch (error) {
      if ((error as { code?: string }).code === 'ER_DUP_ENTRY')
        throw new MaintenancePlanError('duplicate');
      throw error;
    }
  }
  public async get(tenantId: string, id: string): Promise<MaintenancePlan | null> {
    const row = await this.dataSource
      .getRepository(MaintenancePlanEntity)
      .findOneBy({ tenantId, id });
    return row ? fromRow(row) : null;
  }
  public async list(tenantId: string): Promise<readonly MaintenancePlan[]> {
    const rows = await this.dataSource
      .getRepository(MaintenancePlanEntity)
      .find({ where: { tenantId }, order: { id: 'ASC' } });
    return rows.map(fromRow);
  }
  public async readSchedule(tenantId: string, planId: string): Promise<MaintenancePlanSchedule> {
    const plan = await this.get(tenantId, planId);
    if (!plan) throw new MaintenancePlanError('not_found');
    const { targetDate, targetKm } = targets(plan);
    const row = await this.dataSource.getRepository(MaintenanceOccurrenceEntity).findOne({
      where: { tenantId, planId },
      order: { sequence: 'DESC' },
    });
    if (!row)
      return {
        planId,
        nextTargetDate: targetDate,
        nextTargetKm: targetKm,
        occurrence: null,
        order: null,
      };
    const occurrence: PlanOccurrence = {
      id: row.id,
      tenantId: row.tenantId,
      planId: row.planId,
      sequence: row.sequence,
      planVersion: row.planVersion,
      trigger: row.trigger as PlanOccurrence['trigger'],
      targetDate: row.targetDate,
      targetKm: row.targetKm,
      detectedAt: row.detectedAt.toISOString(),
      orderId: row.orderId,
      workshopId: row.workshopId,
      mechanicId: row.mechanicId,
      state: row.state as PlanOccurrence['state'],
    };
    const orderRow = await this.dataSource
      .getRepository(MaintenanceOrderSchema)
      .findOneBy({ tenantId, planId, occurrenceId: row.id });
    const order: ScheduledMaintenanceOrder | null = orderRow
      ? {
          id: orderRow.id,
          tenantId: orderRow.tenantId,
          occurrenceId: orderRow.occurrenceId,
          planId: orderRow.planId,
          vehicleId: orderRow.vehicleId,
          status: orderRow.status as ScheduledMaintenanceOrder['status'],
          kind: orderRow.kind as 'preventive',
          snapshot: orderRow.snapshot as Readonly<Record<string, unknown>>,
          createdAt: orderRow.createdAt.toISOString(),
        }
      : null;
    return { planId, nextTargetDate: targetDate, nextTargetKm: targetKm, occurrence, order };
  }
  public async listScheduledOrders(
    tenantId: string,
    planId: string,
  ): Promise<readonly ScheduledMaintenanceOrder[]> {
    const rows = await this.dataSource.getRepository(MaintenanceOrderSchema).find({
      where: { tenantId, planId },
      order: { createdAt: 'DESC', id: 'DESC' },
    });
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      occurrenceId: row.occurrenceId,
      planId: row.planId,
      vehicleId: row.vehicleId,
      status: row.status as ScheduledMaintenanceOrder['status'],
      kind: row.kind as 'preventive',
      snapshot: row.snapshot as Readonly<Record<string, unknown>>,
      createdAt: row.createdAt.toISOString(),
    }));
  }
  public listAlerts(tenantId: string, query: PlanAlertQuery): Promise<PlanAlertPage> {
    return listPlanAlerts(this.dataSource, tenantId, query);
  }
  public async update(
    plan: MaintenancePlan,
    expectedVersion: number,
    actorId: string,
  ): Promise<boolean> {
    return this.transaction(async (manager) => {
      const updated = await manager
        .getRepository(MaintenancePlanEntity)
        .update({ tenantId: plan.tenantId, id: plan.id, version: expectedVersion }, toRow(plan));
      if (updated.affected !== 1) return false;
      await manager.getRepository(MaintenancePlanVersionEntity).insert({
        tenantId: plan.tenantId,
        planId: plan.id,
        version: plan.version,
        snapshot: plan,
        actorId,
        createdAt: new Date(plan.updatedAt),
      });
      await this.audit(manager, plan, actorId, 'maintenance.plan.updated');
      return true;
    });
  }
  private async audit(
    manager: EntityManager,
    plan: MaintenancePlan,
    actorId: string,
    action: string,
  ): Promise<void> {
    await appendMaintenanceAudit(manager, {
      tenantId: plan.tenantId,
      action,
      entityType: 'maintenance_plan',
      entityId: plan.id,
      actorId,
      occurredAt: plan.updatedAt,
      revision: String(plan.version),
    });
  }
  public async nextSequence(tenantId: string, planId: string): Promise<number> {
    const row = await this.dataSource
      .getRepository(MaintenancePlanEntity)
      .findOneBy({ tenantId, id: planId });
    if (!row) throw new MaintenancePlanError('not_found');
    const last = (await this.dataSource
      .getRepository('MaintenanceOccurrenceEntity')
      .findOne({ where: { tenantId, planId }, order: { sequence: 'DESC' } })) as {
      sequence?: number;
    } | null;
    return (last?.sequence ?? 0) + 1;
  }

  public scan(
    tenantId: string,
    planId: string,
    now: Date,
    odometer: OdometerReading,
    timeZone?: string,
  ): Promise<readonly PlanEvaluation[]> {
    return this.workerStore.scan(tenantId, planId, now, odometer, timeZone);
  }
  public enqueueScans(tenantId: string, now: Date): Promise<number> {
    return this.workerStore.enqueueScans(tenantId, now);
  }
  public closePreventive(event: PreventiveOrderClosedEvent): Promise<void> {
    return this.workerStore.closePreventive(event);
  }
  public reopenPreventive(event: PreventiveOrderLifecycleEvent): Promise<void> {
    return this.workerStore.reopenPreventive(event);
  }
  public cancelPreventive(event: PreventiveOrderLifecycleEvent): Promise<void> {
    return this.workerStore.cancelPreventive(event);
  }
  public adoptPreventive(event: PreventiveOrderLifecycleEvent): Promise<void> {
    return this.workerStore.adoptPreventive(event);
  }
  public baselineBeforeClosure(tenantId: string, planId: string, occurrenceId: string) {
    return this.workerStore.baselineBeforeClosure(tenantId, planId, occurrenceId);
  }
}
