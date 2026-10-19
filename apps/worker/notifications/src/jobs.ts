import { createHash } from 'node:crypto';
import {
  EXPIRY_THRESHOLDS,
  expiryTitle,
  type NotificationDispatcher,
  type NotificationIngest,
} from '../../../../packages/domain/notifications/src/index.js';
import type { ExpiryItem, NotificationSources } from './ports.js';

/** The shape the worker loop runs (`apps/worker/composition` `WorkerJob`). */
export interface WorkerJob {
  readonly name: string;
  run(): Promise<unknown>;
}

export const NOTIFICATIONS_DISPATCH_JOB = 'notifications.dispatch';
export const NOTIFICATIONS_SCAN_JOB = 'notifications.scan';
/** Documents expire by the day: the scan looks at most this often. */
export const NOTIFICATIONS_SCAN_INTERVAL_MS = 60 * 60_000;
/** A document that expired longer ago than this is not announced (it was never announced before). */
export const EXPIRED_GRACE_DAYS = 3;

export interface NotificationJobDeps {
  readonly dispatcher: Pick<NotificationDispatcher, 'runDue'>;
  readonly ingest: Pick<NotificationIngest, 'ingest'>;
  readonly sources: NotificationSources;
  /** Ids of the companies whose jobs may run: active ones only. */
  readonly activeTenantIds: () => readonly string[];
  readonly clock: () => number;
}

/** The threshold an item has reached: the smallest of 30, 15, 7 and 0 days that still covers it; none beyond 30. */
export function thresholdOf(days: number): number | null {
  if (days > EXPIRY_THRESHOLDS[0] || days < -EXPIRED_GRACE_DAYS) return null;
  return [...EXPIRY_THRESHOLDS].reverse().find((threshold) => days <= threshold) ?? null;
}

const digest = (value: string): string =>
  createHash('sha256').update(value).digest('hex').slice(0, 12);

async function scanTenant(deps: NotificationJobDeps, tenantId: string): Promise<number> {
  const { sources } = deps;
  const fleet = await sources.holders(tenantId, 'edit');
  const labels = new Map<string, string>();
  let created = 0;
  for (const item of await sources.expiring(tenantId)) {
    const threshold = thresholdOf(item.daysToExpiry);
    if (threshold === null) continue;
    created += (await announce(deps, tenantId, item, threshold, fleet, labels)).created;
  }
  return created;
}

async function announce(
  deps: NotificationJobDeps,
  tenantId: string,
  item: ExpiryItem,
  threshold: number,
  fleet: readonly string[],
  labels: Map<string, string>,
) {
  const onVehicle = item.vehicleId !== null;
  let label = '';
  if (item.vehicleId !== null) {
    if (!labels.has(item.vehicleId))
      labels.set(item.vehicleId, (await deps.sources.vehicleLabel(tenantId, item.vehicleId)) ?? '');
    label = labels.get(item.vehicleId) as string;
  }
  return deps.ingest.ingest({
    tenantId,
    kind: 'document_expiring',
    // A document or policy is announced on its vehicle, so a follower of the vehicle gets it too.
    entityType: onVehicle ? 'vehicle' : 'employee',
    entityId: item.vehicleId ?? item.subjectId,
    title: expiryTitle(item.source, item.daysToExpiry, label),
    link: onVehicle
      ? `/flota/vehiculos/${item.vehicleId}`
      : `/plantilla/empleados/${item.subjectId}`,
    severity: threshold <= 7 ? 'important' : 'attention',
    // A renewal moves the due date: the cycle starts again. The subject tells two records of one vehicle apart.
    dateVersion: `${item.dueOn}.${digest(item.subjectId)}`,
    threshold: `d${threshold}`,
    recipients: fleet,
  });
}

/**
 * Registered on the worker loop. A company that fails does not stop the others; its failure is
 * rethrown once every company has been tried, so the loop reports the job by name.
 */
export function notificationJobs(deps: NotificationJobDeps): readonly WorkerJob[] {
  const everyTenant = async (work: (tenantId: string) => Promise<number>): Promise<number> => {
    let total = 0;
    let failure: unknown;
    for (const tenantId of deps.activeTenantIds()) {
      try {
        total += await work(tenantId);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
    return total;
  };
  let lastScan = Number.NEGATIVE_INFINITY;
  return [
    {
      name: NOTIFICATIONS_DISPATCH_JOB,
      run: () =>
        everyTenant(async (tenantId) => {
          const summary = await deps.dispatcher.runDue(tenantId);
          return summary.sent + summary.retried + summary.failed + summary.suppressed;
        }),
    },
    {
      name: NOTIFICATIONS_SCAN_JOB,
      run: async () => {
        const now = deps.clock();
        if (now - lastScan < NOTIFICATIONS_SCAN_INTERVAL_MS) return 0;
        lastScan = now;
        return everyTenant((tenantId) => scanTenant(deps, tenantId));
      },
    },
  ];
}
