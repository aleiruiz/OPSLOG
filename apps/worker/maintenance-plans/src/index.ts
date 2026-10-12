import type { Handler } from '../../base/src/index.js';
import type {
  MaintenancePlanWorker,
  PreventiveOrderClosedEvent,
  PreventiveOrderLifecycleEvent,
} from '../../../../packages/domain/maintenance/plans/src/index.js';

export const MAINTENANCE_PLAN_SCAN_EVENT = 'maintenance.plan.scan';
export const PREVENTIVE_ORDER_CLOSED_EVENT = 'maintenance.order.preventive_closed';
export const PREVENTIVE_ORDER_REOPENED_EVENT = 'maintenance.order.preventive_reopened';
export const PREVENTIVE_ORDER_CANCELLED_EVENT = 'maintenance.order.preventive_cancelled';
export const PREVENTIVE_ORDER_ADOPTED_EVENT = 'maintenance.order.preventive_adopted';

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid maintenance job');
  return value as Record<string, unknown>;
}
function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error('invalid maintenance job');
}

/** Registers handlers on the shared durable outbox worker; tenant always comes from its claimed envelope. */
export function registerMaintenancePlanHandlers(
  worker: { register(type: string, handler: Handler): void },
  plans: MaintenancePlanWorker,
): void {
  worker.register(MAINTENANCE_PLAN_SCAN_EVENT, async (payload, event) => {
    const job = record(payload);
    onlyKeys(job, ['planId', 'correlationId']);
    if (
      typeof job['planId'] !== 'string' ||
      (job['correlationId'] !== undefined && typeof job['correlationId'] !== 'string')
    )
      throw new Error('invalid maintenance scan job');
    await plans.scan(event.tenantId, job['planId']);
  });
  worker.register(PREVENTIVE_ORDER_CLOSED_EVENT, async (payload, event) => {
    const job = record(payload);
    onlyKeys(job, [
      'planId',
      'occurrenceId',
      'orderId',
      'kind',
      'completedAt',
      'actualDate',
      'actualKm',
      'version',
    ]);
    if (
      typeof job['planId'] !== 'string' ||
      typeof job['occurrenceId'] !== 'string' ||
      typeof job['orderId'] !== 'string' ||
      (job['kind'] !== 'preventive' && job['kind'] !== 'corrective') ||
      typeof job['completedAt'] !== 'string' ||
      typeof job['actualDate'] !== 'string' ||
      !Number.isInteger(job['actualKm']) ||
      (job['version'] !== undefined && !Number.isInteger(job['version']))
    )
      throw new Error('invalid maintenance closure event');
    const closure: PreventiveOrderClosedEvent = {
      tenantId: event.tenantId,
      planId: job['planId'],
      occurrenceId: job['occurrenceId'],
      orderId: job['orderId'],
      kind: job['kind'],
      eventId: event.eventId,
      completedAt: job['completedAt'],
      actualDate: job['actualDate'],
      actualKm: job['actualKm'] as number,
      ...(job['version'] === undefined ? {} : { version: job['version'] as number }),
    };
    await plans.consumeClosure(closure);
  });
  const lifecycle: readonly [string, (event: PreventiveOrderLifecycleEvent) => Promise<void>][] = [
    [PREVENTIVE_ORDER_REOPENED_EVENT, (event) => plans.consumeReopened(event)],
    [PREVENTIVE_ORDER_CANCELLED_EVENT, (event) => plans.consumeCancelled(event)],
    [PREVENTIVE_ORDER_ADOPTED_EVENT, (event) => plans.consumeAdopted(event)],
  ];
  for (const [type, consume] of lifecycle)
    worker.register(type, async (payload, event) => {
      const job = record(payload);
      onlyKeys(job, ['planId', 'occurrenceId', 'orderId', 'version']);
      if (
        typeof job['planId'] !== 'string' ||
        typeof job['occurrenceId'] !== 'string' ||
        typeof job['orderId'] !== 'string' ||
        !Number.isInteger(job['version'])
      )
        throw new Error('invalid maintenance lifecycle event');
      await consume({
        tenantId: event.tenantId,
        planId: job['planId'],
        occurrenceId: job['occurrenceId'],
        orderId: job['orderId'],
        eventId: event.eventId,
        version: job['version'] as number,
      });
    });
}
