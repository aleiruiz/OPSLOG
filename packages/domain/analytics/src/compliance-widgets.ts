import { DOCUMENT_TYPES } from '../../documents/src/index.js';
import { UPCOMING_DAYS, UPCOMING_KM } from './catalog.js';
import { daysBetween } from './calendar.js';
import { isAlive } from './fleet-widgets.js';
import type {
  EmployeeFact,
  OwnerScope,
  PlanFact,
  RequiredDocumentFact,
  VehicleFact,
} from './ports.js';
import { percentOf } from './stats.js';
import type { RatioPart } from './types.js';

/** The document types that must be on file, per owner (`required` in the documents catalog). */
export const REQUIRED_TYPES: Readonly<Record<'vehicle' | 'employee', readonly string[]>> = {
  vehicle: Object.entries(DOCUMENT_TYPES.vehicle)
    .filter(([, rule]) => rule === 'required')
    .map(([code]) => code),
  employee: Object.entries(DOCUMENT_TYPES.employee)
    .filter(([, rule]) => rule === 'required')
    .map(([code]) => code),
};

/**
 * The owners a document count is restricted to: the vehicles and employees that are not archived,
 * with or without an area filter, so the figure per area adds up to the company figure.
 */
export function ownerScope(
  vehicles: readonly VehicleFact[],
  employees: readonly EmployeeFact[],
): OwnerScope {
  return {
    vehicle: vehicles.filter((vehicle) => vehicle.archivedAt === null).map((vehicle) => vehicle.id),
    employee: employees.map((employee) => employee.id),
  };
}

/**
 * Plans due soon: active plans of a live vehicle whose target date is `UPCOMING_DAYS` or fewer days
 * from today (an overdue date counts), or whose target km is `UPCOMING_KM` or fewer above the last
 * reading (a reading with no timestamp is not a reading, as in the plan scan).
 */
export function upcomingPlans(
  plans: readonly PlanFact[],
  vehicles: readonly VehicleFact[],
  today: string,
): number {
  const alive = new Map(vehicles.filter(isAlive).map((vehicle) => [vehicle.id, vehicle]));
  return plans.filter((plan) => {
    const vehicle = alive.get(plan.vehicleId);
    if (!vehicle) return false;
    const dateSoon =
      plan.targetDate !== null && daysBetween(today, plan.targetDate) <= UPCOMING_DAYS;
    const kmSoon =
      plan.targetKm !== null &&
      vehicle.odometerUpdatedAt !== null &&
      plan.targetKm - vehicle.odometerKm <= UPCOMING_KM;
    return dateSoon || kmSoon;
  }).length;
}

export interface DocumentCoverage {
  readonly numerator: number;
  readonly denominator: number;
  readonly percent: number | null;
  readonly parts: readonly RatioPart[];
}

/**
 * Required documents on file today. The slots are (live vehicle, required vehicle type) and
 * (active driver, required employee type); a slot is covered when a non-archived document of that
 * type has its last valid day today or later. A missing document counts as not covered.
 */
export function documentCoverage(
  vehicles: readonly VehicleFact[],
  employees: readonly EmployeeFact[],
  valid: readonly RequiredDocumentFact[],
): DocumentCoverage {
  const covered = new Set(
    valid.map((fact) => `${fact.ownerType}\u0000${fact.ownerId}\u0000${fact.typeCode}`),
  );
  const slots = (
    subject: 'vehicle' | 'driver',
    ownerType: 'vehicle' | 'employee',
    ids: readonly string[],
  ): RatioPart => {
    const types = REQUIRED_TYPES[ownerType];
    let numerator = 0;
    for (const id of ids)
      for (const type of types)
        if (covered.has(`${ownerType}\u0000${id}\u0000${type}`)) numerator += 1;
    return { subject, numerator, denominator: ids.length * types.length };
  };
  const parts = [
    slots(
      'vehicle',
      'vehicle',
      vehicles.filter(isAlive).map((vehicle) => vehicle.id),
    ),
    slots(
      'driver',
      'employee',
      employees
        .filter((employee) => employee.kind === 'driver' && employee.status === 'active')
        .map((employee) => employee.id),
    ),
  ];
  const numerator = parts.reduce((total, part) => total + part.numerator, 0);
  const denominator = parts.reduce((total, part) => total + part.denominator, 0);
  return { numerator, denominator, percent: percentOf(numerator, denominator), parts };
}

export const activeVehicleIds = (vehicles: readonly VehicleFact[]): readonly string[] =>
  vehicles
    .filter((vehicle) => vehicle.archivedAt === null && vehicle.status === 'active')
    .map((vehicle) => vehicle.id);
