import type { FilePipeline } from '../../../../../packages/platform/files/src/index.js';
import {
  createWorkerRuntime,
  type WorkerRuntime,
} from '../../../../worker/composition/src/index.js';
import { ROLE_PERMISSIONS } from '../access.js';
import { ACTOR_PREFIX, type PlatformKernel } from './kernel.js';
import type { PlatformOptions } from './types.js';
import type { MaintenancePlanWorker } from '../../../../../packages/domain/maintenance/plans/src/index.js';
import { registerIncidentSlaHandlers } from '../../../../worker/incident-sla/src/index.js';
import { registerMaintenancePlanHandlers } from '../../../../worker/maintenance-plans/src/index.js';

/** Worker runtime over the platform's outbox, tenants and pipeline; the actor's current role gates each job. */
export function buildWorkerRuntime(
  kernel: PlatformKernel,
  pipeline: FilePipeline,
  worker: PlatformOptions['worker'],
  auditRelay?: { runBatch(max?: number): Promise<number> },
  maintenancePlans?: MaintenancePlanWorker,
  incidentSla?: Parameters<typeof registerIncidentSlaHandlers>[1],
): WorkerRuntime {
  const runtime = createWorkerRuntime({
    outbox: kernel.outbox,
    tenants: kernel.tenants,
    actors: {
      // Current role, not the one at enqueue time: a revoked or demoted actor's pending jobs stop.
      allows: async (tenantId, actor, permission) => {
        if (!actor.subject.startsWith(ACTOR_PREFIX)) return false;
        const role = await kernel.access.effectiveRole(
          tenantId,
          actor.subject.slice(ACTOR_PREFIX.length),
        );
        if (!role) return false;
        return permission === undefined || ROLE_PERMISSIONS[role].includes(permission as never);
      },
    },
    audit: kernel.audit,
    ...(auditRelay ? { auditRelay } : {}),
    pipeline: pipeline,
    clock: () => kernel.now().getTime(),
    ...worker,
  });
  if (maintenancePlans) registerMaintenancePlanHandlers(runtime.worker, maintenancePlans);
  if (incidentSla) registerIncidentSlaHandlers(runtime.worker, incidentSla);
  return runtime;
}
