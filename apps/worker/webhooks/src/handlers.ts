import type { Handler } from '../../base/src/index.js';
import {
  eventIdOf,
  type EligibilityTracker,
  type DriverSource,
  type PublicEvent,
  type WebhookEvent,
  type WebhookIngest,
} from '../../../../packages/domain/webhooks/src/index.js';
import type { WebhookSources } from './ports.js';

export interface HandlerDeps {
  readonly ingest: Pick<WebhookIngest, 'publish'>;
  readonly tracker: Pick<EligibilityTracker, 'check'>;
  readonly drivers: Pick<DriverSource, 'driver'>;
  readonly sources: WebhookSources;
  readonly now: () => Date;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const STATUS = /^[a-z_]{1,32}$/;

/** The payload of an event, read as strictly as its producer wrote it; anything else is refused and retried. */
function fields(payload: unknown, required: readonly string[]): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload))
    throw new Error('invalid webhook event');
  const record = payload as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => !required.includes(key)) ||
    required.some((key) => record[key] === undefined)
  )
    throw new Error('invalid webhook event');
  return record;
}
const id = (value: unknown): string => {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error('invalid webhook event');
  return value;
};
const status = (value: unknown): string => {
  if (typeof value !== 'string' || !STATUS.test(value)) throw new Error('invalid webhook event');
  return value;
};
const version = (value: unknown): void => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0)
    throw new Error('invalid webhook event');
};

type Data = PublicEvent['data'];
/** What an outbox event says about the public one: `null` when the record is gone. */
type Builder = (deps: HandlerDeps, tenantId: string, payload: unknown) => Promise<Data | null>;

const vehicleEvent =
  (withStatus: boolean): Builder =>
  async ({ sources }, tenantId, payload) => {
    const data = fields(
      payload,
      withStatus ? ['vehicleId', 'status', 'version'] : ['vehicleId', 'version'],
    );
    version(data['version']);
    const vehicleId = id(data['vehicleId']);
    const facts = await sources.vehicle(tenantId, vehicleId);
    if (!facts) return null;
    return {
      vehicleId,
      economicNumber: facts.economicNumber,
      status: withStatus ? status(data['status']) : facts.status,
    };
  };

const driverEvent: Builder = async ({ drivers }, tenantId, payload) => {
  const data = fields(payload, ['driverId', 'version']);
  version(data['version']);
  const driverId = id(data['driverId']);
  const facts = await drivers.driver(tenantId, driverId);
  return facts ? { driverId, eligible: facts.eligible } : null;
};

const incidentEvent =
  (kind: 'created' | 'status' | 'closed'): Builder =>
  async ({ sources }, tenantId, payload) => {
    const data = fields(
      payload,
      kind === 'status'
        ? ['incidentId', 'vehicleId', 'version', 'status']
        : ['incidentId', 'vehicleId', 'version'],
    );
    version(data['version']);
    const incidentId = id(data['incidentId']);
    const facts = await sources.incident(tenantId, incidentId);
    if (!facts) return null;
    const base = { incidentId, folio: facts.folio, vehicleId: id(data['vehicleId']) };
    if (kind === 'status') return { ...base, status: status(data['status']) };
    return kind === 'closed' ? { ...base, status: 'closed' } : base;
  };

const orderEvent: Builder = async ({ sources }, tenantId, payload) => {
  const data = fields(payload, ['orderId', 'vehicleId', 'version']);
  version(data['version']);
  const orderId = id(data['orderId']);
  const facts = await sources.order(tenantId, orderId);
  return facts ? { orderId, vehicleId: id(data['vehicleId']), status: facts.status } : null;
};

/** `driver.eligibility_changed` is derived by the tracker, never read from the outbox. */
const BUILDERS: Readonly<Record<Exclude<WebhookEvent, 'driver.eligibility_changed'>, Builder>> = {
  'vehicle.created': vehicleEvent(false),
  'vehicle.updated': vehicleEvent(false),
  'vehicle.status_changed': vehicleEvent(true),
  'driver.created': driverEvent,
  'driver.updated': driverEvent,
  'incident.created': incidentEvent('created'),
  'incident.status_changed': incidentEvent('status'),
  'incident.closed': incidentEvent('closed'),
  'maintenance.created': orderEvent,
  'maintenance.status_changed': orderEvent,
};

/** Outbox events that also tell the tracker to look at one driver again. */
const DRIVER_EVENTS = new Set<string>(['driver.created', 'driver.updated']);

/**
 * One handler per outbox event that has a public name. The company always comes from the claimed
 * envelope. The public id derives from the outbox id, so a retried event is the same event and the
 * deduplication of the deliveries absorbs it.
 */
export function webhookHandlers(deps: HandlerDeps): Readonly<Record<string, Handler>> {
  const entries = Object.entries(BUILDERS) as [keyof typeof BUILDERS, Builder][];
  return Object.fromEntries(
    entries.map(([type, build]): [string, Handler] => [
      type,
      async (payload, event) => {
        const data = await build(deps, event.tenantId, payload);
        if (!data) return;
        await deps.ingest.publish(event.tenantId, {
          eventId: eventIdOf(event.tenantId, `${event.eventId}:${type}`),
          type,
          occurredAt: deps.now().toISOString(),
          data,
        });
        if (DRIVER_EVENTS.has(type))
          await deps.tracker.check(event.tenantId, id((payload as { driverId: string }).driverId));
      },
    ]),
  );
}
