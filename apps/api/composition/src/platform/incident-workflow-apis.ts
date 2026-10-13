import type {
  IncidentChildStore,
  IncidentFiles,
} from '../../../../../packages/domain/incidents/third-parties/src/index.js';
import {
  IncidentProcessService,
  IncidentWorkflowService,
  type IncidentClosures,
  type IncidentEvidenceFacts,
  type WorkflowPorts,
} from '../../../../../packages/domain/incidents/workflow/src/index.js';
import {
  INCIDENT_STATUSES,
  IncidentService,
  TERMINAL_STATUSES,
  type IncidentStore,
} from '../../../../../packages/domain/incidents/cases/src/index.js';
import type { IncidentRepairStore } from '../../../../../packages/domain/incidents/repairs/src/index.js';
import { InMemoryMechanicStore } from '../../../../../packages/domain/maintenance/mechanics/src/index.js';
import { IncidentWorkflowApi } from '../../../incidents/workflow/src/index.js';
import { ROLE_PERMISSIONS } from '../access.js';
import { incidentLabels, incidentReferences, type IncidentServices } from './incident-apis.js';
import type { PlatformKernel } from './kernel.js';
import { createMechanicScope } from './mechanic-scope.js';
import type { PlatformAdapters } from './types.js';

/**
 * Evidence of a case as the workflow reads it: category, stage, whether the file is `clean` and
 * whether it still waits for its scan. A file the files module forgot is neither, so it never
 * satisfies a requirement.
 */
export function evidenceFacts(
  children: IncidentChildStore,
  files: IncidentFiles,
): IncidentEvidenceFacts {
  return {
    evidence: async (tenantId, incidentId) =>
      Promise.all(
        (await children.evidence(tenantId, incidentId)).map(async (row) => {
          const status = (await files.record(tenantId, row.fileId))?.status;
          return {
            id: row.id,
            category: row.category,
            stage: row.stage,
            clean: status === 'clean',
            // Waiting for the scan or for the bytes: nobody has judged the file yet.
            pending: status === 'pending_scan' || status === 'pending_upload',
          };
        }),
      ),
  };
}

/**
 * Whether the vehicle is held by another open case that says it cannot operate (D11, SPECS §5.3).
 * Every non-terminal case counts, drafts included; the case asking is left out. The store caps the
 * page size, never the number of cases.
 */
export async function incidentHoldsVehicle(
  store: IncidentStore,
  tenantId: string,
  vehicleId: string,
  exceptIncidentId: string | null,
): Promise<boolean> {
  const open = INCIDENT_STATUSES.filter((status) => !TERMINAL_STATUSES.includes(status));
  const query = {
    filter: { vehicleId, statuses: open },
    sort: 'createdAt',
    direction: 'asc',
    limit: 100,
    offset: 0,
  } as const;
  for (let offset = 0; ; offset += 100) {
    const page = await store.list(tenantId, { ...query, offset });
    if (page.items.some((item) => item.id !== exceptIncidentId && item.vehicleOperable === false))
      return true;
    if (offset + 100 >= page.total || page.items.length === 0) return false;
  }
}

/** What the workflow, and the evidence guard, share: one set of ports, so INC-COSTS plugs in once. */
export interface WorkflowPortSources {
  readonly kernel: PlatformKernel;
  readonly services: IncidentServices;
  readonly store: IncidentStore;
  readonly evidence: IncidentEvidenceFacts;
  /** Ids of the open workshop orders of the vehicle (MNT-ORDERS). */
  readonly openWorkshopOrders: (tenantId: string, vehicleId: string) => Promise<readonly string[]>;
  readonly closures: IncidentClosures;
  /** The links to the workshop's orders: the orders that repair a case do not hold its vehicle. */
  readonly repairLinks: Pick<IncidentRepairStore, 'links'>;
  /** The ports of INC-COSTS (`costPorts`). */
  readonly cost: Pick<WorkflowPorts, 'repairs' | 'costs' | 'totals' | 'closureCosts'>;
}

/**
 * Ports of the workflow. The repairs, the costs, their totals and their closure snapshot are the
 * real ones of INC-COSTS; they live in this one object, so the workflow, the process data and the
 * evidence guard all follow.
 */
export function workflowPorts(sources: WorkflowPortSources): WorkflowPorts {
  const { kernel, services, store } = sources;
  return {
    references: incidentReferences(services),
    evidence: sources.evidence,
    settings: {
      reportPhoto: async (tenantId) => (await services.settings.get(tenantId)).incidentReportPhoto,
      closeCostThreshold: async (tenantId) =>
        (await services.settings.get(tenantId)).closeCostThreshold,
    },
    members: {
      // The permissions of the member's role; a removed or unknown member is absent.
      permissionsOf: async (tenantId, memberId) => {
        const role = await kernel.access.effectiveRole(tenantId, memberId);
        return role ? ROLE_PERMISSIONS[role] : null;
      },
    },
    ...sources.cost,
    blocks: {
      // The orders that repair the case itself (linked, whatever their state) do not hold its vehicle.
      blocked: async (tenantId, vehicleId, exceptIncidentId) => {
        const own = new Set(
          (await sources.repairLinks.links(tenantId, exceptIncidentId)).map((link) => link.orderId),
        );
        const open = await sources.openWorkshopOrders(tenantId, vehicleId);
        return (
          open.some((orderId) => !own.has(orderId)) ||
          (await incidentHoldsVehicle(store, tenantId, vehicleId, exceptIncidentId))
        );
      },
    },
    closures: sources.closures,
  };
}

/** The workflow API over the shared incident store. */
export function buildIncidentWorkflowApi(
  kernel: PlatformKernel,
  adapters: PlatformAdapters,
  services: IncidentServices,
  store: IncidentStore,
  ports: WorkflowPorts,
): IncidentWorkflowApi {
  const scope = createMechanicScope(adapters.maintenanceMechanics ?? new InMemoryMechanicStore());
  const options = { now: kernel.now };
  return new IncidentWorkflowApi({
    incidents: new IncidentService(store, incidentReferences(services), options),
    workflow: new IncidentWorkflowService(store, ports, options),
    process: new IncidentProcessService(store, ports, options),
    authorize: async (token, correlationId) => {
      const context = await kernel.authorize(token, correlationId, []);
      return { context, permissions: await kernel.access.resolvePermissions(context) };
    },
    mechanicLinked: scope.mechanicLinked,
    labels: incidentLabels(kernel, services),
    deny: (context, action, entityId, correlationId) =>
      kernel.auditNow(kernel.userActor(context), action, 'incident', entityId, correlationId),
  });
}
