import type {
  Employee,
  EmployeeDetail,
  EmployeeHistoryEntry,
  EmployeeKind,
  EmployeeStatus,
} from '../app/types';
import { fitnessOf } from './rules';

/** Synthetic employees for the mock API, tests and stories. Nothing here is real data. */

/** The day the stories, the mock and the unit tests treat as "today". */
export const FIXTURE_TODAY = '2026-10-06';

export type EmployeePiiValues = NonNullable<EmployeeDetail['pii']>;

export const noPii: EmployeePiiValues = {
  nationalId: null,
  phone: null,
  email: null,
  licenseNumber: null,
};

/** Obviously fictional personal data (reserved `.test` domain, ficticious phone range, "EJEM" identifiers). */
export const demoPii: EmployeePiiValues = {
  nationalId: 'EJEM800101HDFXXX01',
  phone: '+525555550100',
  email: 'ana.garcia@ejemplo.test',
  licenseNumber: 'LIC-000123',
};

const presence = (pii: EmployeePiiValues): Employee['piiPresent'] => ({
  nationalId: pii.nationalId !== null,
  phone: pii.phone !== null,
  email: pii.email !== null,
  licenseNumber: pii.licenseNumber !== null,
});

/** An employee as the list returns it (no personal data, only which fields exist). */
export function makeEmployee(
  overrides: Partial<Employee> = {},
  pii: EmployeePiiValues = demoPii,
): Employee {
  const base: Employee = {
    id: 'emp-001',
    kind: 'driver',
    firstName: 'Ana',
    lastName: 'García López',
    employeeNumber: 'E-0001',
    position: 'Operadora de reparto',
    hireDate: '2023-05-01',
    areaId: 'area-norte',
    status: 'active',
    statusReason: 'Alta',
    idType: 'curp',
    licenseType: 'C',
    licenseExpiresOn: '2028-03-31',
    piiPresent: presence(pii),
    fitness: null,
    version: 3,
    createdAt: '2023-05-01T15:00:00.000Z',
    updatedAt: '2026-09-20T18:30:00.000Z',
    archivedAt: null,
  };
  const merged = { ...base, ...overrides };
  return {
    ...merged,
    fitness: overrides.fitness !== undefined ? overrides.fitness : fitnessOf(merged, FIXTURE_TODAY),
  };
}

/** The single-employee read: with the decrypted values when the session may see them, `null` otherwise. */
export function makeEmployeeDetail(
  overrides: Partial<Employee> = {},
  pii: EmployeePiiValues | null = demoPii,
  /** What the employee has on file, shown by the presence flags even when `pii` is masked (`null`). */
  onFile: EmployeePiiValues = pii ?? demoPii,
): EmployeeDetail {
  return { ...makeEmployee(overrides, onFile), pii };
}

const FIRST = ['Ana', 'Luis', 'María', 'Jorge', 'Sofía', 'Carlos', 'Elena', 'Pablo'] as const;
const LAST = [
  'García López',
  'Hernández Ruiz',
  'Martínez Soto',
  'Ramírez Cruz',
  'Torres Vega',
  'Flores Mora',
  'Domínguez Paz',
] as const;
const AREAS = ['area-norte', 'area-centro', 'area-sur'] as const;
const STATUSES: readonly EmployeeStatus[] = [
  'active',
  'active',
  'active',
  'inactive',
  'suspended',
  'active',
  'terminated',
  'active',
];
const KINDS: readonly EmployeeKind[] = ['driver', 'driver', 'dispatcher', 'other', 'driver'];

/**
 * `count` employees: every kind and status, three areas, drivers with a current, an expired and a missing
 * license. Sorted by last name, then first name, like the server. Identifications are fictional.
 */
export function demoEmployees(count = 28): EmployeeDetail[] {
  return Array.from({ length: count }, (_, index) => {
    const n = index + 1;
    const kind = KINDS[index % KINDS.length] as EmployeeKind;
    const status = STATUSES[index % STATUSES.length] as EmployeeStatus;
    const driver = kind === 'driver';
    // Every fifth driver has no license number, every seventh an expired license.
    const noLicense = driver && n % 5 === 0;
    const expired = driver && n % 7 === 0;
    const pii: EmployeePiiValues = {
      nationalId: `EJEM8001${String(n).padStart(2, '0')}HDFXXX${String(n).padStart(2, '0')}`,
      phone: `+5255555501${String(n).padStart(2, '0')}`,
      email: `empleado${n}@ejemplo.test`,
      licenseNumber: driver && !noLicense ? `LIC-${String(100000 + n)}` : null,
    };
    return makeEmployeeDetail(
      {
        id: `emp-${String(n).padStart(3, '0')}`,
        kind,
        firstName: FIRST[index % FIRST.length] as string,
        lastName: `${LAST[index % LAST.length] as string}`,
        employeeNumber: `E-${String(n).padStart(4, '0')}`,
        position: kind === 'driver' ? 'Conductor' : kind === 'dispatcher' ? 'Despachador' : null,
        hireDate: `2022-${String((index % 12) + 1).padStart(2, '0')}-10`,
        areaId: AREAS[index % AREAS.length] as string,
        status,
        statusReason: status === 'active' ? 'Alta' : 'Cambio de estado de demostración',
        idType: 'curp',
        licenseType: driver && !noLicense ? 'C' : null,
        licenseExpiresOn: driver && !noLicense ? (expired ? '2026-08-31' : '2028-03-31') : null,
        version: 1,
      },
      pii,
    );
  }).sort(
    (a, b) =>
      `${a.lastName} ${a.firstName}`
        .toLowerCase()
        .localeCompare(`${b.lastName} ${b.firstName}`.toLowerCase()) || a.id.localeCompare(b.id),
  );
}

export function makeHistoryEntry(
  overrides: Partial<EmployeeHistoryEntry> = {},
): EmployeeHistoryEntry {
  return {
    id: 'hist-001',
    kind: 'status',
    from: null,
    to: 'active',
    reason: 'Alta',
    actorId: 'user-admin',
    version: 1,
    at: '2023-05-01T15:00:00.000Z',
    ...overrides,
  };
}

/** A believable history, newest first: creation, a suspension and its lifting, an area move. */
export function demoHistory(): EmployeeHistoryEntry[] {
  return [
    makeHistoryEntry({
      id: 'hist-004',
      kind: 'area',
      from: 'area-centro',
      to: 'area-norte',
      reason: null,
      actorId: 'user-dispatch',
      version: 4,
      at: '2026-09-20T18:30:00.000Z',
    }),
    makeHistoryEntry({
      id: 'hist-003',
      from: 'suspended',
      to: 'active',
      reason: 'Concluyó la revisión',
      version: 3,
      at: '2026-03-05T09:05:00.000Z',
    }),
    makeHistoryEntry({
      id: 'hist-002',
      from: 'active',
      to: 'suspended',
      reason: 'Revisión interna en curso',
      version: 2,
      at: '2026-02-02T11:20:00.000Z',
    }),
    makeHistoryEntry({ id: 'hist-001' }),
  ];
}
