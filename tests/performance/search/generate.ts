import {
  employeeProjection,
  vehicleProjection,
  type EmployeeFacts,
  type EntityProjection,
  type VehicleFacts,
} from '../../../packages/domain/search/src/index.js';
import { employee, vehicle } from '../../../packages/domain/search/src/test-support.js';

const LETTERS = 'ABCDEFGHJKLMNPRSTUVXYZ';
const FIRST = [
  'Ana',
  'Luis',
  'María',
  'José',
  'Carmen',
  'Jorge',
  'Lucía',
  'Pedro',
  'Sofía',
  'Iván',
];
const LAST = ['Pérez', 'Gómez', 'Hernández', 'López', 'Martínez', 'Ramírez', 'Torres', 'Flores'];

/** A deterministic plate such as `KLM-482` from the position: the same dataset on every run. */
export function plateOf(index: number): string {
  let n = index;
  let letters = '';
  for (let i = 0; i < 3; i += 1) {
    letters += LETTERS[n % LETTERS.length];
    n = Math.floor(n / LETTERS.length);
  }
  return `${letters}-${String(Math.floor(n % 1000)).padStart(3, '0')}`;
}

/** The source facts of `count` synthetic entities: 70% vehicles and 30% drivers. */
export function syntheticFacts(count: number): {
  vehicles: VehicleFacts[];
  employees: EmployeeFacts[];
} {
  const vehicles: VehicleFacts[] = [];
  const employees: EmployeeFacts[] = [];
  for (let i = 0; i < count; i += 1) {
    if (i % 10 < 7)
      vehicles.push(
        vehicle(`veh-${i}`, {
          economicNumber: `U-${i}`,
          plate: plateOf(i),
          vin: `3N6AD33C${String(i).padStart(9, '0')}`,
        }),
      );
    else
      employees.push(
        employee(`emp-${i}`, {
          firstName: FIRST[i % FIRST.length] as string,
          lastName: `${LAST[Math.floor(i / FIRST.length) % LAST.length]} ${i}`,
          employeeNumber: `N-${i}`,
          licenseIndex: i % 3 === 0 ? i.toString(16).padStart(64, '0') : null,
        }),
      );
  }
  return { vehicles, employees };
}

/**
 * Synthetic entities for one company, built with the same domain builders the indexer uses (so the
 * keys and normalization are the real ones). MVP-OPS reuses this.
 */
export function* syntheticProjections(
  tenantId: string,
  count: number,
): Generator<EntityProjection> {
  const { vehicles, employees } = syntheticFacts(count);
  for (const v of vehicles) {
    const built = vehicleProjection(tenantId, v);
    if (built) yield built;
  }
  for (const e of employees) {
    const built = employeeProjection(tenantId, e);
    if (built) yield built;
  }
}
