import 'reflect-metadata';
import { In, type DataSource, type FindOptionsWhere } from 'typeorm';
import type {
  PlanAlertPage,
  PlanAlertQuery,
  PlanAlertRecord,
} from '../../../../domain/maintenance/plans/src/index.js';
import {
  MaintenanceAlertSchema,
  MaintenancePlanEntity,
  type MaintenancePlanAlertEntity,
} from './entities.js';

/** Reads the in-app alert records the worker persisted. Tenant is part of every selector. */
export async function listPlanAlerts(
  dataSource: DataSource,
  tenantId: string,
  query: PlanAlertQuery,
): Promise<PlanAlertPage> {
  const plans = dataSource.getRepository(MaintenancePlanEntity);
  // Alerts carry the plan, not the vehicle: resolve the vehicle's plans first (a handful per vehicle).
  const rows = await plans.find({
    where: {
      tenantId,
      ...(query.planId === undefined ? {} : { id: query.planId }),
      ...(query.vehicleId === undefined ? {} : { vehicleId: query.vehicleId }),
    },
    select: { id: true, vehicleId: true },
  });
  if (rows.length === 0 && (query.planId !== undefined || query.vehicleId !== undefined))
    return { items: [], total: 0 };
  const vehicleOf = new Map<string, string>();
  const where: FindOptionsWhere<MaintenancePlanAlertEntity> = { tenantId };
  if (query.planId !== undefined || query.vehicleId !== undefined)
    where.planId = In(rows.map((row) => row.id));
  const [found, total] = await dataSource.getRepository(MaintenanceAlertSchema).findAndCount({
    where,
    order: { occurredAt: 'DESC', id: 'DESC' },
    skip: query.offset,
    take: query.limit,
  });
  const missing = [...new Set(found.map((row) => row.planId))].filter(
    (id) => !rows.some((plan) => plan.id === id),
  );
  for (const plan of rows) vehicleOf.set(plan.id, plan.vehicleId);
  if (missing.length > 0)
    for (const plan of await plans.find({
      where: { tenantId, id: In(missing) },
      select: { id: true, vehicleId: true },
    }))
      vehicleOf.set(plan.id, plan.vehicleId);
  const items: PlanAlertRecord[] = found.map((row) => ({
    id: row.id,
    tenantId: row.tenantId,
    planId: row.planId,
    vehicleId: vehicleOf.get(row.planId) ?? '',
    occurrence: row.occurrence,
    planVersion: row.planVersion,
    kind: row.kind as PlanAlertRecord['kind'],
    trigger: row.trigger as PlanAlertRecord['trigger'],
    threshold: row.threshold as PlanAlertRecord['threshold'],
    targetDate: row.targetDate,
    targetKm: row.targetKm,
    odometerLastUpdatedAt: row.odometerLastUpdatedAt?.toISOString() ?? null,
    odometerAgeSeconds: row.odometerAgeSeconds,
    occurredAt: row.occurredAt.toISOString(),
  }));
  return { items, total };
}
