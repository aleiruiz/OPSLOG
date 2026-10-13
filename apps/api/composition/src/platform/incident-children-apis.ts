import { FileError } from '../../../../../packages/domain/files/src/index.js';
import {
  IncidentError,
  InMemoryIncidentStore,
  type IncidentStore,
} from '../../../../../packages/domain/incidents/cases/src/index.js';
import {
  IdentityVault,
  InMemoryIncidentChildStore,
  ThirdPartyService,
  type IncidentChildStore,
  type IncidentFiles,
} from '../../../../../packages/domain/incidents/third-parties/src/index.js';
import {
  GuardedEvidenceService,
  InMemoryIncidentClosures,
  type IncidentClosures,
  type WorkflowPorts,
} from '../../../../../packages/domain/incidents/workflow/src/index.js';
import {
  InMemoryIncidentCostStore,
  type IncidentCostStore,
} from '../../../../../packages/domain/incidents/costs/src/index.js';
import {
  InMemoryIncidentRepairStore,
  type IncidentRepairStore,
} from '../../../../../packages/domain/incidents/repairs/src/index.js';
import { InMemoryWorkOrderStore } from '../../../../../packages/domain/maintenance/orders/src/index.js';
import { InMemoryMechanicStore } from '../../../../../packages/domain/maintenance/mechanics/src/index.js';
import type { PiiCipher } from '../../../../../packages/platform/pii/src/index.js';
import { IncidentChildApi } from '../../../incidents/third-parties/src/index.js';
import { ROLE_LABELS } from '../directory.js';
import {
  buildIncidentWorkflowApi,
  evidenceFacts,
  workflowPorts,
} from './incident-workflow-apis.js';
import {
  UNKNOWN_MEMBER_LABEL,
  buildIncidentApi,
  type IncidentDomainApis,
  type IncidentServices,
} from './incident-apis.js';
import type { PlatformKernel } from './kernel.js';
import { buildIncidentCostApis, costPorts, repairOrderReader } from './incident-cost-apis.js';
import { createMechanicScope } from './mechanic-scope.js';
import type { PlatformAdapters } from './types.js';
import { UPLOAD_REJECTIONS, type WorkOrderFileSupport } from './work-order-apis.js';

/** The stores of the incidents, in memory unless both persistent adapters are injected. */
export function incidentStores(adapters: PlatformAdapters): {
  readonly store: IncidentStore;
  readonly children: IncidentChildStore;
  readonly closures: IncidentClosures;
  readonly repairs: IncidentRepairStore;
  readonly costs: IncidentCostStore;
} {
  // A persistent case with in-memory children or closures (or the reverse) would lose them on
  // restart and skip the one-link-per-file key and the one-closure-per-cycle key: they travel together.
  const injected = [
    adapters.incidents,
    adapters.incidentChildren,
    adapters.incidentClosures,
    adapters.incidentRepairs,
    adapters.incidentCosts,
  ];
  if (injected.some(Boolean) && !injected.every(Boolean))
    throw new Error(
      'adapters.incidents, incidentChildren, incidentClosures, incidentRepairs and incidentCosts must be injected together',
    );
  const store = adapters.incidents ?? new InMemoryIncidentStore();
  return {
    store,
    children: adapters.incidentChildren ?? new InMemoryIncidentChildStore(store),
    closures: adapters.incidentClosures ?? new InMemoryIncidentClosures(),
    repairs: adapters.incidentRepairs ?? new InMemoryIncidentRepairStore(store),
    costs: adapters.incidentCosts ?? new InMemoryIncidentCostStore(store),
  };
}

/** A file that cannot be served maps to the closest case error; nothing of the files module leaks. */
function fileFailure(code: string | undefined): Error {
  return code === 'not_found'
    ? new IncidentError('not_found')
    : code === 'forbidden'
      ? new IncidentError('forbidden')
      : code === 'not_available'
        ? new IncidentError('invalid_transition')
        : new Error('File could not be served');
}

/** The files module as the case uses it: uploads through its pipeline, records through its store. */
export function incidentFiles(support: WorkOrderFileSupport): IncidentFiles {
  return {
    record: async (tenantId, fileId) => {
      const record = await support.records.get(tenantId, fileId);
      return record
        ? {
            id: record.id,
            status: record.status,
            kind: record.kind,
            sensitivity: record.sensitivity,
            createdBy: record.createdBy,
            displayName: record.displayName,
            contentType: record.contentType,
            sizeBytes: record.sizeBytes,
          }
        : null;
    },
    // The received bytes become the preserved original, untouched (D18, ADR-0014); the pipeline
    // quarantines, scans and hashes them, and derivatives are separate files.
    ingest: async (tenantId, actorId, correlationId, input) => {
      try {
        const record = await support.pipeline.ingestOriginal(
          { tenantId, actorId, actorKind: 'user', correlationId },
          { name: input.name, declaredType: input.contentType, bytes: input.bytes },
        );
        return { id: record.id };
      } catch (error) {
        // A rejected upload (type, content or size) is the caller's input, not a server fault.
        if (error instanceof FileError && UPLOAD_REJECTIONS.has(error.code))
          throw new IncidentError('invalid_input', [{ field: 'file', code: 'invalid' }]);
        throw error;
      }
    },
  };
}

/** Third parties and evidence of the incidents over the shared stores, the cipher and the files module. */
export function buildIncidentChildApi(
  kernel: PlatformKernel,
  adapters: PlatformAdapters,
  stores: ReturnType<typeof incidentStores>,
  pii: PiiCipher,
  support: WorkOrderFileSupport,
  ports: WorkflowPorts,
): IncidentChildApi {
  const scope = createMechanicScope(adapters.maintenanceMechanics ?? new InMemoryMechanicStore());
  const options = { now: kernel.now };
  return new IncidentChildApi({
    thirdParties: new ThirdPartyService(
      stores.store,
      stores.children,
      new IdentityVault(pii),
      options,
    ),
    // Unlinking the budget that stands for "an order or a budget" is refused while in repair (ADR-0014).
    evidence: new GuardedEvidenceService(
      stores.store,
      stores.children,
      incidentFiles(support),
      // The same ports as the workflow: INC-COSTS plugs in once.
      ports,
      options,
    ),
    authorize: async (token, correlationId) => {
      const context = await kernel.authorize(token, correlationId, []);
      return { context, permissions: await kernel.access.resolvePermissions(context) };
    },
    mechanicLinked: scope.mechanicLinked,
    labels: {
      member: async (tenantId, actorId) => {
        const role = await kernel.access.effectiveRole(tenantId, actorId.replace(/^user-/, ''));
        return role ? ROLE_LABELS[role] : UNKNOWN_MEMBER_LABEL;
      },
    },
    files: {
      // The grant and the download re-authenticate the session and audit the access in the files module.
      read: async (token, correlationId, fileId) => {
        const grant = await support.files.createDownloadGrant(token, correlationId, fileId);
        if (!grant.ok || !grant.value) throw fileFailure(grant.error?.code);
        const served = await support.files.download(token, correlationId, grant.value.grant);
        if (!served.ok || !served.value) throw fileFailure(served.error?.code);
        return served.value.body;
      },
    },
    audit: (context, action, entityId, correlationId) =>
      kernel.auditNow(kernel.userActor(context), action, 'incident', entityId, correlationId),
    // A refused access is audited like any other denied attempt; the audit trail has no payload.
    deny: (context, action, entityId, correlationId) =>
      kernel.auditNow(kernel.userActor(context), action, 'incident', entityId, correlationId),
  });
}

/** Incidents with their third parties and evidence, over one shared store and one set of workflow ports. */
export function buildIncidentApis(
  kernel: PlatformKernel,
  adapters: PlatformAdapters,
  services: IncidentServices,
  pii: PiiCipher,
  support: WorkOrderFileSupport,
  stores: ReturnType<typeof incidentStores> = incidentStores(adapters),
): IncidentDomainApis {
  const evidence = evidenceFacts(stores.children, incidentFiles(support));
  const orders = repairOrderReader(adapters);
  const cost = costPorts(stores.repairs, stores.costs, orders);
  const ports = workflowPorts({
    kernel,
    services,
    store: stores.store,
    evidence,
    openWorkshopOrders: async (tenantId, vehicleId) =>
      (
        await (adapters.maintenanceOrders ?? new InMemoryWorkOrderStore()).openWorkshopOrders(
          tenantId,
          vehicleId,
        )
      ).map((order) => order.id),
    closures: stores.closures,
    repairLinks: stores.repairs,
    cost,
  });
  return {
    incidents: buildIncidentApi(kernel, adapters, services, stores.store),
    incidentChildren: buildIncidentChildApi(kernel, adapters, stores, pii, support, ports),
    incidentWorkflow: buildIncidentWorkflowApi(kernel, adapters, services, stores.store, ports),
    ...buildIncidentCostApis(kernel, adapters, services, stores, orders, evidence, cost.ledger),
  };
}
