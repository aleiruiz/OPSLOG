import type { MaintenancePlan } from '../../../../domain/maintenance/plans/src/index.js';
import type { MaintenancePlanEntity } from './entities.js';

export function fromRow(row: MaintenancePlanEntity): MaintenancePlan {
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
export function toRow(value: MaintenancePlan): Partial<MaintenancePlanEntity> {
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
