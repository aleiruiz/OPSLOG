import type { FilePipeline } from '../../../../../packages/platform/files/src/index.js';
import {
  createWorkerRuntime,
  DEFAULT_PLAN_SCAN_INTERVAL_MS,
  DEFAULT_SEARCH_RECONCILE_INTERVAL_MS,
  DEFAULT_SLA_SCAN_INTERVAL_MS,
  type PeriodicTenantJob,
  type WorkerRuntime,
} from '../../../../worker/composition/src/index.js';
import { ROLE_PERMISSIONS } from '../access.js';
import { ACTOR_PREFIX, type PlatformKernel } from './kernel.js';
import type { PlatformOptions } from './types.js';
import type { MaintenancePlanWorker } from '../../../../../packages/domain/maintenance/plans/src/index.js';
import { registerIncidentSlaHandlers } from '../../../../worker/incident-sla/src/index.js';
import { registerMaintenancePlanHandlers } from '../../../../worker/maintenance-plans/src/index.js';
import { registerSearchHandlers } from '../../../../worker/composition/src/search-consumer.js';
import type { SearchModule } from './search-apis.js';

/** Name of the periodic SLA scan job in `runtime.periodic`. */
export const INCIDENT_SLA_SCAN_JOB = 'incident.sla.scan';
/** Name of the periodic maintenance plan scan job in `runtime.periodic`. */
export const MAINTENANCE_PLAN_SCAN_JOB = 'maintenance.plan.scan';
/** Name of the periodic search projection reconcile job in `runtime.periodic`. */
export const SEARCH_RECONCILE_JOB = 'search.reconcile';

/** Worker runtime over the platform's outbox, tenants and pipeline; the actor's current role gates each job. */
export function buildWorkerRuntime(
  kernel: PlatformKernel,
  pipeline: FilePipeline,
  worker: PlatformOptions['worker'],
  auditRelay?: { runBatch(max?: number): Promise<number> },
  maintenancePlans?: MaintenancePlanWorker,
  incidentSla?: Parameters<typeof registerIncidentSlaHandlers>[1] & {
    readonly enqueueScan: (tenantId: string) => Promise<void>;
  },
  search?: SearchModule,
): WorkerRuntime {
  // The incident SLA scan is queued per active tenant on a local timer; the host calls
  // `runtime.periodic.start()`. The cloud trigger (EventBridge or similar) stays deferred (ADR-0002).
  const periodic: PeriodicTenantJob[] = [
    ...(incidentSla
      ? [
          {
            name: INCIDENT_SLA_SCAN_JOB,
            intervalMs: worker?.slaScanIntervalMs ?? DEFAULT_SLA_SCAN_INTERVAL_MS,
            enqueue: (tenantId: string) => incidentSla.enqueueScan(tenantId),
          },
        ]
      : []),
    // Preventive orders are born from this scan; one job per active plan, deduplicated per hour.
    ...(maintenancePlans
      ? [
          {
            name: MAINTENANCE_PLAN_SCAN_JOB,
            intervalMs: worker?.planScanIntervalMs ?? DEFAULT_PLAN_SCAN_INTERVAL_MS,
            enqueue: async (tenantId: string) =>
              void (await maintenancePlans.enqueueScans(tenantId)),
          },
        ]
      : []),
    // The global search projection follows the modules: one reconcile job per active tenant.
    ...(search
      ? [
          {
            name: SEARCH_RECONCILE_JOB,
            intervalMs: worker?.searchReconcileIntervalMs ?? DEFAULT_SEARCH_RECONCILE_INTERVAL_MS,
            enqueue: (tenantId: string) => search.enqueueReconcile(tenantId),
          },
        ]
      : []),
  ];
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
    periodic,
    tenantIds: () => kernel.tenants.all().map((tenant) => tenant.id),
    clock: () => kernel.now().getTime(),
    ...(worker?.leaseMs === undefined ? {} : { leaseMs: worker.leaseMs }),
    ...(worker?.maxAttempts === undefined ? {} : { maxAttempts: worker.maxAttempts }),
  });
  if (maintenancePlans) registerMaintenancePlanHandlers(runtime.worker, maintenancePlans);
  if (incidentSla) registerIncidentSlaHandlers(runtime.worker, incidentSla);
  if (search) registerSearchHandlers(runtime.worker, search.indexer);
  return runtime;
}
