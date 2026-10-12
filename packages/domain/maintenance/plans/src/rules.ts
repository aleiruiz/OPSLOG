import { MaintenancePlanError } from './errors.js';
import type { MaintenancePlan, PlanInput } from './types.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDateOnly(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function opaqueId(value: unknown): string {
  if (typeof value !== 'string' || !ID.test(value)) throw new MaintenancePlanError('invalid_input');
  return value;
}

function date(value: unknown): string {
  if (!isValidDateOnly(value)) throw new MaintenancePlanError('invalid_input');
  return value;
}

export function parsePlanInput(input: unknown): PlanInput {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new MaintenancePlanError('invalid_input');
  const data = input as Record<string, unknown>;
  const allowed = new Set([
    'vehicleId',
    'intervalDays',
    'intervalKm',
    'lastServiceDate',
    'lastServiceKm',
    'defaultWorkshopId',
    'defaultMechanicId',
  ]);
  if (Object.keys(data).some((key) => !allowed.has(key)))
    throw new MaintenancePlanError('invalid_input');
  const intervalDays = data['intervalDays'];
  const intervalKm = data['intervalKm'];
  if (intervalDays === undefined && intervalKm === undefined)
    throw new MaintenancePlanError('invalid_input');
  if (
    intervalDays !== undefined &&
    (!Number.isInteger(intervalDays) ||
      (intervalDays as number) < 1 ||
      (intervalDays as number) > 3650)
  )
    throw new MaintenancePlanError('invalid_input');
  if (
    intervalKm !== undefined &&
    (!Number.isInteger(intervalKm) ||
      (intervalKm as number) < 1 ||
      (intervalKm as number) > 9_999_999)
  )
    throw new MaintenancePlanError('invalid_input');
  if (
    data['lastServiceKm'] !== undefined &&
    (!Number.isInteger(data['lastServiceKm']) ||
      (data['lastServiceKm'] as number) < 0 ||
      (data['lastServiceKm'] as number) > 9_999_999)
  )
    throw new MaintenancePlanError('invalid_input');
  const lastServiceDate =
    data['lastServiceDate'] === undefined ? undefined : date(data['lastServiceDate']);
  const lastServiceKm = data['lastServiceKm'] as number | undefined;
  return {
    vehicleId: opaqueId(data['vehicleId']),
    ...(intervalDays === undefined ? {} : { intervalDays: intervalDays as number }),
    ...(intervalKm === undefined ? {} : { intervalKm: intervalKm as number }),
    ...(lastServiceDate === undefined ? {} : { lastServiceDate }),
    ...(lastServiceKm === undefined ? {} : { lastServiceKm }),
    ...(data['defaultWorkshopId'] === undefined
      ? {}
      : {
          defaultWorkshopId:
            data['defaultWorkshopId'] === null ? null : opaqueId(data['defaultWorkshopId']),
        }),
    ...(data['defaultMechanicId'] === undefined
      ? {}
      : {
          defaultMechanicId:
            data['defaultMechanicId'] === null ? null : opaqueId(data['defaultMechanicId']),
        }),
  };
}

export function makePlan(
  tenantId: string,
  id: string,
  input: PlanInput,
  now: Date,
): MaintenancePlan {
  if (
    (input.intervalDays !== undefined && input.lastServiceDate === undefined) ||
    (input.intervalKm !== undefined && input.lastServiceKm === undefined)
  )
    throw new MaintenancePlanError('invalid_input');
  return {
    ...input,
    id,
    tenantId,
    state: 'active',
    version: 1,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

export function addCalendarDays(isoDate: string, days: number): string {
  const value = new Date(`${isoDate}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function targets(plan: MaintenancePlan): {
  targetDate: string | null;
  targetKm: number | null;
} {
  return {
    targetDate:
      plan.intervalDays === undefined
        ? null
        : addCalendarDays(plan.lastServiceDate!, plan.intervalDays),
    targetKm: plan.intervalKm === undefined ? null : plan.lastServiceKm! + plan.intervalKm,
  };
}

export function patchPlan(plan: MaintenancePlan, patch: PlanInput, now: Date): MaintenancePlan {
  if (patch.vehicleId !== plan.vehicleId) throw new MaintenancePlanError('invalid_input');
  return {
    ...plan,
    ...patch,
    state: plan.state,
    version: plan.version + 1,
    updatedAt: now.toISOString(),
  };
}
