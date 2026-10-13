import type { AssignmentStore } from '../../../../../packages/domain/assignments/src/index.js';
import {
  EmployeeError,
  type EmployeeService,
} from '../../../../../packages/domain/employees/src/index.js';
import {
  IncidentService,
  type AssignmentRef,
  type IncidentStore,
  type IncidentReferences,
  type PolicyRevisionRef,
} from '../../../../../packages/domain/incidents/cases/src/index.js';
import type { PolicyStore } from '../../../../../packages/domain/insurance/src/index.js';
import type { SettingsService } from '../../../../../packages/domain/settings/src/index.js';
import {
  VehicleError,
  type VehicleService,
} from '../../../../../packages/domain/vehicles/src/index.js';
import { allowedCommands } from '../../../../../packages/domain/incidents/workflow/src/index.js';
import { IncidentApi, type IncidentLabels } from '../../../incidents/cases/src/index.js';
import type { IncidentWorkflowApi } from '../../../incidents/workflow/src/index.js';
import type { IncidentCostApi } from '../../../incidents/costs/src/index.js';
import type { IncidentRepairApi } from '../../../incidents/repairs/src/index.js';
import type { IncidentChildApi } from '../../../incidents/third-parties/src/index.js';
import { ROLE_LABELS } from '../directory.js';
import type { PlatformKernel } from './kernel.js';
import { InMemoryMechanicStore } from '../../../../../packages/domain/maintenance/mechanics/src/index.js';
import { createMechanicScope } from './mechanic-scope.js';
import type { PlatformAdapters } from './types.js';

/** Shown when a member's role cannot be resolved (for example a member removed since). */
export const UNKNOWN_MEMBER_LABEL = 'Otra persona de la empresa';
const PAGE = 100;

/** Every row of a paged port, in order; ports cap the page size, never the number of rows. */
async function allRows<T>(
  page: (offset: number) => Promise<{ readonly items: readonly T[]; readonly total: number }>,
): Promise<readonly T[]> {
  const rows: T[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const slice = await page(offset);
    rows.push(...slice.items);
    if (offset + PAGE >= slice.total || slice.items.length === 0) return rows;
  }
}

/** The incident API as a member of the composed domain APIs. */
export interface IncidentDomainApis {
  readonly incidents: IncidentApi;
  readonly incidentChildren: IncidentChildApi;
  readonly incidentWorkflow: IncidentWorkflowApi;
  readonly incidentRepairs: IncidentRepairApi;
  readonly incidentCosts: IncidentCostApi;
}

export interface IncidentServices {
  readonly vehicles: VehicleService;
  readonly employees: EmployeeService;
  readonly assignments: AssignmentStore;
  readonly policies: PolicyStore;
  readonly settings: SettingsService;
}

const findVehicle = (services: IncidentServices, tenantId: string, id: string) =>
  services.vehicles.get(tenantId, id).catch((error: unknown) => {
    if (error instanceof VehicleError && error.code === 'not_found') return null;
    throw error;
  });
const findEmployee = (services: IncidentServices, tenantId: string, id: string) =>
  services.employees.get(tenantId, id).catch((error: unknown) => {
    if (error instanceof EmployeeError && error.code === 'not_found') return null;
    throw error;
  });

/** The ports of INC-CASES over the fleet modules. Unknown, foreign and archived ids all read as absent. */
export function incidentReferences(services: IncidentServices): IncidentReferences {
  return {
    vehicle: async (tenantId, vehicleId, options) => {
      const found = await findVehicle(services, tenantId, vehicleId);
      return found && (options?.includeArchived === true || found.archivedAt === null)
        ? { id: found.id, areaId: found.areaId, registeredOn: found.registeredOn }
        : null;
    },
    // A driver who left keeps the historical reference: any status counts, archived ones too.
    driver: async (tenantId, employeeId) => {
      const found = await findEmployee(services, tenantId, employeeId);
      return found && found.kind === 'driver'
        ? { id: found.id, displayName: `${found.firstName} ${found.lastName}`.trim() }
        : null;
    },
    assignments: async (tenantId, vehicleId) =>
      (
        await allRows((offset) =>
          services.assignments.list(tenantId, { vehicleId }, { limit: PAGE, offset }),
        )
      ).map(
        (assignment): AssignmentRef => ({
          employeeId: assignment.employeeId,
          type: assignment.type,
          startedAt: assignment.startedAt,
          endedAt: assignment.endedAt,
        }),
      ),
    // Archived and renewed policies are history that still covers past event days (BR-019).
    policyRevisions: async (tenantId, vehicleId) => {
      const policies = await allRows((offset) =>
        services.policies.list(
          tenantId,
          { vehicleId, includeArchived: true },
          { limit: PAGE, offset },
        ),
      );
      const revisions = await Promise.all(
        policies.map(async (policy) =>
          (
            await allRows((offset) =>
              services.policies.revisions(tenantId, policy.id, { limit: PAGE, offset }),
            )
          ).map(
            (revision): PolicyRevisionRef => ({
              policyId: policy.id,
              revision: revision.revision,
              insurer: policy.insurer,
              policyNumber: revision.policyNumber,
              coverageType: revision.coverageType,
              startsOn: revision.startsOn,
              endsOn: revision.endsOn,
            }),
          ),
        ),
      );
      return revisions.flat();
    },
    timeZone: async (tenantId) => (await services.settings.get(tenantId)).timeZone,
  };
}

/** The names the incident views show: vehicle, driver and member (a member shows as their role). */
export function incidentLabels(kernel: PlatformKernel, services: IncidentServices): IncidentLabels {
  return {
    vehicle: async (tenantId, vehicleId) => {
      const found = await findVehicle(services, tenantId, vehicleId);
      return found ? { economicNumber: found.economicNumber, plate: found.plate } : null;
    },
    driver: async (tenantId, employeeId) => {
      const found = await findEmployee(services, tenantId, employeeId);
      return found ? `${found.firstName} ${found.lastName}`.trim() : null;
    },
    // The identity contract carries no names yet: a member shows as their role.
    member: async (tenantId, actorId) => {
      const role = await kernel.access.effectiveRole(tenantId, actorId.replace(/^user-/, ''));
      return role ? ROLE_LABELS[role] : UNKNOWN_MEMBER_LABEL;
    },
  };
}

/** Incidents (INC-CASES): the service over the store, the ports above and the session-bound API. */
export function buildIncidentApi(
  kernel: PlatformKernel,
  adapters: PlatformAdapters,
  services: IncidentServices,
  store: IncidentStore,
): IncidentApi {
  const scope = createMechanicScope(adapters.maintenanceMechanics ?? new InMemoryMechanicStore());
  return new IncidentApi({
    incidents: new IncidentService(store, incidentReferences(services), { now: kernel.now }),
    authorize: async (token, correlationId) => {
      const context = await kernel.authorize(token, correlationId, []);
      return { context, permissions: await kernel.access.resolvePermissions(context) };
    },
    mechanicLinked: scope.mechanicLinked,
    labels: incidentLabels(kernel, services),
    allowedCommands,
    // A refused access is audited like any other denied attempt; the audit trail has no payload.
    deny: (context, action, entityId, correlationId) =>
      kernel.auditNow(kernel.userActor(context), action, 'incident', entityId, correlationId),
  });
}
