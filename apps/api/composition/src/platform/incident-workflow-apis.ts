import type {
  IncidentChildStore,
  IncidentFiles,
} from '../../../../../packages/domain/incidents/third-parties/src/index.js';
import {
  IncidentProcessService,
  IncidentWorkflowService,
  FAIL_CLOSED_COSTS,
  FAIL_CLOSED_REPAIRS,
  FAIL_CLOSED_TOTALS,
  type IncidentEvidenceFacts,
  type WorkflowPorts,
} from '../../../../../packages/domain/incidents/workflow/src/index.js';
import {
  IncidentService,
  type IncidentStore,
} from '../../../../../packages/domain/incidents/cases/src/index.js';
import { InMemoryMechanicStore } from '../../../../../packages/domain/maintenance/mechanics/src/index.js';
import { IncidentWorkflowApi } from '../../../incidents/workflow/src/index.js';
import { ROLE_PERMISSIONS } from '../access.js';
import { incidentLabels, incidentReferences, type IncidentServices } from './incident-apis.js';
import type { PlatformKernel } from './kernel.js';
import { createMechanicScope } from './mechanic-scope.js';
import type { PlatformAdapters } from './types.js';

/**
 * Evidence of a case as the workflow reads it: category, stage and whether the file is `clean`.
 * A file the files module forgot is not clean, so it never satisfies a requirement.
 */
export function evidenceFacts(
  children: IncidentChildStore,
  files: IncidentFiles,
): IncidentEvidenceFacts {
  return {
    evidence: async (tenantId, incidentId) =>
      Promise.all(
        (await children.evidence(tenantId, incidentId)).map(async (row) => ({
          id: row.id,
          category: row.category,
          stage: row.stage,
          clean: (await files.record(tenantId, row.fileId))?.status === 'clean',
        })),
      ),
  };
}

/**
 * Ports of the workflow. The repairs, the costs and their totals belong to INC-COSTS, which does
 * not exist yet: they are the fail-closed ports, so nothing that depends on them can pass.
 */
export function workflowPorts(
  kernel: PlatformKernel,
  services: IncidentServices,
  evidence: IncidentEvidenceFacts,
): WorkflowPorts {
  return {
    references: incidentReferences(services),
    evidence,
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
    repairs: FAIL_CLOSED_REPAIRS,
    costs: FAIL_CLOSED_COSTS,
    totals: FAIL_CLOSED_TOTALS,
  };
}

/** The workflow API over the shared incident store. */
export function buildIncidentWorkflowApi(
  kernel: PlatformKernel,
  adapters: PlatformAdapters,
  services: IncidentServices,
  store: IncidentStore,
  evidence: IncidentEvidenceFacts,
): IncidentWorkflowApi {
  const scope = createMechanicScope(adapters.maintenanceMechanics ?? new InMemoryMechanicStore());
  const ports = workflowPorts(kernel, services, evidence);
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
