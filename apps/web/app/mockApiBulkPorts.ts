import { ok } from './mockApiErrors';
import type { Guarded, MockApiOptions, MockControls } from './mockApiTypes';
import type { MockAreaStore } from './mockAreas';
import { createMockAssignmentStore, type MockAssignmentStore } from './mockAssignments';
import type { MockEmployeeStore } from './mockEmployees';
import { createMockImportStore, importWritesPii, type MockImportStore } from './mockImports';
import type { MockVehicleStore } from './mockVehicles';
import { normalizePlate } from '../vehicles/rules';
import type { ApiPorts } from './types';

export interface BulkStores {
  readonly assigned: MockAssignmentStore;
  readonly bulk: MockImportStore;
}

/** The assignment and import stores, over the vehicles, staff and areas of the mock company. */
export function createBulkStores(
  options: Pick<MockApiOptions, 'assignments' | 'imports'>,
  fleet: MockVehicleStore,
  staff: MockEmployeeStore,
  orgTree: MockAreaStore,
  actorId: () => string,
): BulkStores {
  const assigned = createMockAssignmentStore(
    {
      isEligibleVehicle: (vehicleId) =>
        fleet
          .snapshot()
          .some(
            (vehicle) =>
              vehicle.id === vehicleId &&
              vehicle.archivedAt === null &&
              vehicle.status !== 'inactive' &&
              vehicle.status !== 'decommissioned',
          ),
      isEligibleDriver: (employeeId) =>
        staff
          .snapshot()
          .some(
            (employee) =>
              employee.id === employeeId &&
              employee.kind === 'driver' &&
              employee.status === 'active' &&
              employee.archivedAt === null,
          ),
      actorId,
    },
    options.assignments,
  );
  const bulk = createMockImportStore(
    {
      isActiveArea: (areaId) =>
        orgTree.snapshot().some((area) => area.id === areaId && area.active),
      existingKeys: (entity) =>
        new Set(
          entity === 'vehicle'
            ? fleet
                .snapshot()
                .flatMap((vehicle) => [
                  `economicNumber:${vehicle.economicNumber.toLowerCase()}`,
                  `plate:${normalizePlate(vehicle.plate)}`,
                  ...(vehicle.vin ? [`vin:${vehicle.vin.toUpperCase()}`] : []),
                ])
            : staff
                .snapshot()
                .flatMap((employee) =>
                  employee.employeeNumber
                    ? [`employeeNumber:${employee.employeeNumber.toLowerCase()}`]
                    : [],
                ),
        ),
      createRecord: async (entity, input) => {
        const created =
          entity === 'vehicle'
            ? await fleet.port.create(input as unknown as Parameters<typeof fleet.port.create>[0])
            : await staff.port.create(input as unknown as Parameters<typeof staff.port.create>[0]);
        return created.ok ? ok({ id: created.value.id }) : created;
      },
      actorId,
    },
    options.imports,
  );
  return { assigned, bulk };
}

/** Test controls over the assignments and imports of the mock server. */
export const createBulkControls = ({
  assigned,
  bulk,
}: BulkStores): Pick<MockControls, 'endAssignmentExternally' | 'assignments' | 'imports'> => ({
  endAssignmentExternally: (id) => assigned.endExternally(id),
  assignments: () => assigned.snapshot(),
  imports: () => bulk.snapshot(),
});

/** Guarded ports: each operation checks the session and its permission like the BFF does. */
export function createBulkPorts(
  guarded: Guarded,
  { assigned, bulk }: BulkStores,
): Pick<ApiPorts, 'assignments' | 'imports'> {
  return {
    assignments: {
      list: (query) => guarded('listAssignments', 'view', () => assigned.port.list(query)),
      get: (id) => guarded('getAssignment', 'view', () => assigned.port.get(id)),
      // Replacing the principal closes another assignment: it needs `edit` besides `create`, like the server.
      assign: (input) =>
        guarded(
          'assign',
          (input as { replace?: unknown } | null)?.replace === true ? ['create', 'edit'] : 'create',
          () => assigned.port.assign(input),
        ),
      end: (id, end) => guarded('endAssignment', 'edit', () => assigned.port.end(id, end)),
      history: (id, query) =>
        guarded('assignmentHistory', 'view', () => assigned.port.history(id, query)),
    },
    imports: {
      list: (query) => guarded('listImports', 'view', () => bulk.port.list(query)),
      get: (id) => guarded('getImport', 'view', () => bulk.port.get(id)),
      // Rows with personal-data columns need `view_pii` besides `create`, like creating that employee.
      submit: (input) =>
        guarded('submitImport', importWritesPii(input) ? ['create', 'view_pii'] : 'create', () =>
          bulk.port.submit(input),
        ),
      rows: (id, query) => guarded('importRows', 'view', () => bulk.port.rows(id, query)),
      history: (id, query) => guarded('importHistory', 'view', () => bulk.port.history(id, query)),
    },
  };
}
