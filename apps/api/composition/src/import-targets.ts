import { AreaError, type AreaService } from '../../../../packages/domain/areas/src/index.js';
import {
  EmployeeError,
  employeeNumberKey,
  nationalIdKey,
  normalizeEmail,
  normalizeEmployeeNumber,
  normalizeNationalId,
  parseNewEmployee,
  isEmployeeKind,
  type EmployeeConflictField,
  type EmployeeService,
} from '../../../../packages/domain/employees/src/index.js';
import type {
  CreateOutcome,
  ImportTarget,
  RowIssue,
} from '../../../../packages/domain/imports/src/index.js';
import {
  VehicleError,
  economicNumberKey,
  normalizeEconomicNumber,
  normalizePlate,
  normalizeVin,
  parseNewVehicle,
  plateKey,
  type VehicleConflictField,
  type VehicleService,
} from '../../../../packages/domain/vehicles/src/index.js';

/** Rows read per page, and pages read, when listing the stored records to find existing keys. */
const SCAN_PAGE = 100;
const SCAN_MAX_PAGES = 100;

type Input = Readonly<Record<string, unknown>>;

/**
 * Columns whose value the entity's own validation refuses, found by probing: every present column
 * is put alone into a request that is valid otherwise. Reuses the entity's rules instead of
 * restating them, so the two can never disagree. A failure no single column explains (a rule that
 * spans columns) is reported against every column of the row, never silently accepted.
 */
function probeColumns(
  input: Input,
  baseline: Input,
  parse: (candidate: Input) => unknown,
  groups: readonly (readonly string[])[] = [],
): readonly string[] {
  const grouped = new Set(groups.flat());
  const units: (readonly string[])[] = [
    ...Object.keys(input)
      .filter((column) => !grouped.has(column))
      .map((column) => [column]),
    ...groups.filter((group) => group.some((column) => Object.hasOwn(input, column))),
  ];
  const bad: string[] = [];
  for (const unit of units) {
    const candidate: Record<string, unknown> = { ...baseline };
    for (const column of unit) if (Object.hasOwn(input, column)) candidate[column] = input[column];
    try {
      parse(candidate);
    } catch {
      bad.push(...unit.filter((column) => Object.hasOwn(input, column)));
    }
  }
  return bad.length > 0 ? bad : Object.keys(input);
}

/** Active-area check per distinct area (read only). */
async function inactiveAreas(
  areas: AreaService,
  tenantId: string,
  inputs: readonly Input[],
): Promise<ReadonlySet<string>> {
  const gone = new Set<string>();
  for (const areaId of new Set(inputs.map((input) => String(input['areaId']))))
    try {
      if (!(await areas.get(tenantId, areaId)).active) gone.add(areaId);
    } catch (error) {
      // Unknown and foreign areas are both `not_found`: gone. Anything else is not a verdict.
      if (!(error instanceof AreaError) || error.code !== 'not_found') throw error;
      gone.add(areaId);
    }
  return gone;
}

const duplicate = (columns: readonly string[]): RowIssue => ({ code: 'duplicate', columns });
const INVALID_AREA: RowIssue = { code: 'invalid_area', columns: ['areaId'] };

export interface VehicleTargetDeps {
  readonly vehicles: VehicleService;
  readonly areas: AreaService;
}

const VEHICLE_COLUMN: Readonly<Record<VehicleConflictField, string>> = {
  economic_number: 'economicNumber',
  plate: 'plate',
  vin: 'vin',
  area_id: 'areaId',
};

const VEHICLE_BASELINE: Input = {
  economicNumber: 'E-1',
  plate: 'AB1',
  make: 'Marca',
  model: 'Modelo',
  year: 2020,
  areaId: 'area-baseline',
  odometerKm: 0,
};

/** Imports vehicles through `VehicleService`: its VIN, plate and number uniqueness and its area rule apply as on a single create. */
export function vehicleImportTarget(deps: VehicleTargetDeps): ImportTarget {
  return {
    invalidColumns: (input, now) => {
      try {
        parseNewVehicle(input, now);
        return [];
      } catch {
        return probeColumns(input, VEHICLE_BASELINE, (candidate) =>
          parseNewVehicle(candidate, now),
        );
      }
    },
    keys: (input) => {
      const vin = Object.hasOwn(input, 'vin') ? normalizeVin(input['vin']) : null;
      return [
        ['economicNumber', economicNumberKey(normalizeEconomicNumber(input['economicNumber']))],
        ['plate', plateKey(normalizePlate(input['plate']))],
        ...(vin === null ? [] : [['vin', vin] as const]),
      ];
    },
    precheck: async (tenantId, inputs) => {
      const taken = {
        economicNumber: new Set<string>(),
        plate: new Set<string>(),
        vin: new Set<string>(),
      };
      for (let page = 0; page < SCAN_MAX_PAGES; page += 1) {
        const slice = await deps.vehicles.list(tenantId, {
          includeArchived: true,
          limit: SCAN_PAGE,
          offset: page * SCAN_PAGE,
        });
        for (const vehicle of slice.items) {
          taken.economicNumber.add(economicNumberKey(vehicle.economicNumber));
          taken.plate.add(plateKey(vehicle.plate));
          if (vehicle.vin !== null) taken.vin.add(vehicle.vin);
        }
        if ((page + 1) * SCAN_PAGE >= slice.total) break;
      }
      const gone = await inactiveAreas(deps.areas, tenantId, inputs);
      return inputs.map((input) => {
        const clashes = [
          taken.economicNumber.has(
            economicNumberKey(normalizeEconomicNumber(input['economicNumber'])),
          )
            ? 'economicNumber'
            : null,
          taken.plate.has(plateKey(normalizePlate(input['plate']))) ? 'plate' : null,
          Object.hasOwn(input, 'vin') && taken.vin.has(normalizeVin(input['vin']) as string)
            ? 'vin'
            : null,
        ].filter((column): column is string => column !== null);
        if (clashes.length > 0) return duplicate(clashes);
        return gone.has(String(input['areaId'])) ? INVALID_AREA : null;
      });
    },
    create: async (tenantId, actorId, input): Promise<CreateOutcome> => {
      try {
        return { id: (await deps.vehicles.create(tenantId, actorId, input)).id };
      } catch (error) {
        if (!(error instanceof VehicleError)) throw error;
        if (error.code === 'duplicate')
          return { issue: duplicate(error.field ? [VEHICLE_COLUMN[error.field]] : []) };
        if (error.code === 'invalid_area') return { issue: INVALID_AREA };
        if (error.code === 'invalid_input')
          return { issue: { code: 'invalid_value', columns: Object.keys(input) } };
        throw error;
      }
    },
  };
}

export interface EmployeeTargetDeps {
  readonly employees: EmployeeService;
  readonly areas: AreaService;
}

const EMPLOYEE_COLUMN: Readonly<Record<EmployeeConflictField, string>> = {
  employee_number: 'employeeNumber',
  national_id: 'nationalId',
  email: 'email',
  area_id: 'areaId',
};

const EMPLOYEE_BASELINE: Input = {
  kind: 'driver',
  firstName: 'Nombre',
  lastName: 'Apellido',
  areaId: 'area-baseline',
};

/**
 * Imports employees through `EmployeeService`: area rule, uniqueness of number, identification and
 * e-mail, and the sealing of personal data (PiiCipher) are exactly those of a single create. The
 * identification and the e-mail are unique through blind indexes the service keeps, so a clash with
 * a stored employee is only discovered when the row is written: a dry run reports clashes of the
 * employee number and inside the request, and the rest surface as `duplicate` on commit.
 */
export function employeeImportTarget(deps: EmployeeTargetDeps): ImportTarget {
  return {
    invalidColumns: (input, now) => {
      try {
        parseNewEmployee(input, now);
        return [];
      } catch {
        // The probe baseline takes the row's own kind (when valid), so license columns on a row that
        // is not a driver are refused on their own, whatever their value.
        const kind = isEmployeeKind(input['kind']) ? input['kind'] : EMPLOYEE_BASELINE['kind'];
        return probeColumns(
          input,
          { ...EMPLOYEE_BASELINE, kind },
          (candidate) => parseNewEmployee(candidate, now),
          [['idType', 'nationalId']],
        );
      }
    },
    keys: (input) => [
      ...(Object.hasOwn(input, 'employeeNumber')
        ? [
            [
              'employeeNumber',
              employeeNumberKey(normalizeEmployeeNumber(input['employeeNumber'])),
            ] as const,
          ]
        : []),
      ...(Object.hasOwn(input, 'nationalId')
        ? [
            [
              'nationalId',
              nationalIdKey(
                String(input['idType']).trim().toLowerCase(),
                normalizeNationalId(input['nationalId']),
              ),
            ] as const,
          ]
        : []),
      ...(Object.hasOwn(input, 'email')
        ? [['email', normalizeEmail(input['email'])] as const]
        : []),
    ],
    precheck: async (tenantId, inputs) => {
      const numbers = new Set<string>();
      for (let page = 0; page < SCAN_MAX_PAGES; page += 1) {
        const slice = await deps.employees.list(tenantId, {
          includeArchived: true,
          limit: SCAN_PAGE,
          offset: page * SCAN_PAGE,
        });
        for (const employee of slice.items)
          if (employee.employeeNumber !== null)
            numbers.add(employeeNumberKey(employee.employeeNumber));
        if ((page + 1) * SCAN_PAGE >= slice.total) break;
      }
      const gone = await inactiveAreas(deps.areas, tenantId, inputs);
      return inputs.map((input) => {
        if (
          Object.hasOwn(input, 'employeeNumber') &&
          numbers.has(employeeNumberKey(normalizeEmployeeNumber(input['employeeNumber'])))
        )
          return duplicate(['employeeNumber']);
        return gone.has(String(input['areaId'])) ? INVALID_AREA : null;
      });
    },
    create: async (tenantId, actorId, input): Promise<CreateOutcome> => {
      try {
        return { id: (await deps.employees.create(tenantId, actorId, input)).id };
      } catch (error) {
        if (!(error instanceof EmployeeError)) throw error;
        if (error.code === 'duplicate')
          return { issue: duplicate(error.field ? [EMPLOYEE_COLUMN[error.field]] : []) };
        if (error.code === 'invalid_area') return { issue: INVALID_AREA };
        if (error.code === 'invalid_input')
          return { issue: { code: 'invalid_value', columns: Object.keys(input) } };
        throw error;
      }
    },
  };
}
