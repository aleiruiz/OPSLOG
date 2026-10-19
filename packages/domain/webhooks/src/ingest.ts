import { randomUUID } from 'node:crypto';
import type { WebhookStore } from './ports.js';
import { bodyOf } from './payload.js';
import type { NewDelivery, PublicEvent } from './types.js';

export interface IngestDeps {
  readonly store: WebhookStore;
  readonly now: () => Date;
}

/**
 * Fans an event out to the active endpoints of ONE company that subscribed to it. The delivery key
 * is (company, endpoint, event id): the same fact twice creates one delivery per endpoint.
 */
export class WebhookIngest {
  public constructor(private readonly deps: IngestDeps) {}

  public async publish(tenantId: string, event: PublicEvent): Promise<number> {
    const { store } = this.deps;
    const createdAt = this.deps.now().toISOString();
    const targets = (await store.endpoints(tenantId)).filter(
      (endpoint) =>
        endpoint.active &&
        (event.type === 'ping' || endpoint.events.some((name) => name === event.type)),
    );
    const deliveries: NewDelivery[] = targets.map((endpoint) => ({
      id: `whd_${randomUUID()}`,
      tenantId,
      endpointId: endpoint.id,
      eventId: event.eventId,
      eventType: event.type,
      body: bodyOf(endpoint, event),
      createdAt,
    }));
    return deliveries.length === 0 ? 0 : store.addDeliveries(deliveries);
  }
}
