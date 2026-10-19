import { randomUUID } from 'node:crypto';
import { UrlRejected } from '../../../platform/webhooks/src/index.js';
import {
  MAX_ENDPOINTS,
  PING_EVENT,
  SECRET_GRACE_MS,
  isWebhookEvent,
  type WebhookEvent,
} from './catalog.js';
import { WebhookError } from './errors.js';
import type { WebhookIngest } from './ingest.js';
import { bodyOf, newCompanyRef, randomEventId } from './payload.js';
import type { WebhookStore } from './ports.js';
import type { SecretVault } from './secrets.js';
import type { Endpoint, DeliveryView, EndpointView, Slice, Window } from './types.js';
import { deliveryView, endpointView } from './views.js';

export interface ServiceDeps {
  readonly store: WebhookStore;
  readonly vault: SecretVault;
  readonly ingest: WebhookIngest;
  /** Registration-time destination check (syntax and DNS); throws `UrlRejected`. */
  readonly validateUrl: (url: string) => Promise<void>;
  readonly now: () => Date;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const asId = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !ID.test(value)) throw new WebhookError('not_found', field);
  return value;
};
const asVersion = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1)
    throw new WebhookError('invalid_input', 'version');
  return value;
};

function asEvents(value: unknown): WebhookEvent[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20)
    throw new WebhookError('invalid_input', 'events');
  const events = value.filter(isWebhookEvent);
  if (events.length !== value.length || new Set(events).size !== events.length)
    throw new WebhookError('invalid_input', 'events');
  return events;
}

/** The commands of the administrator. The tenant always comes from the session. */
export class WebhookService {
  public constructor(private readonly deps: ServiceDeps) {}

  private async checkUrl(value: unknown): Promise<string> {
    if (typeof value !== 'string') throw new WebhookError('invalid_input', 'url');
    try {
      await this.deps.validateUrl(value);
    } catch (error) {
      if (error instanceof UrlRejected) throw new WebhookError('invalid_input', 'url');
      throw error;
    }
    return value;
  }

  private async load(tenantId: string, id: unknown): Promise<Endpoint> {
    const found = await this.deps.store.endpoint(tenantId, asId(id, 'id'));
    if (!found) throw new WebhookError('not_found');
    return found;
  }

  /** Returns the secret: this is the only time it can be read. */
  public async create(
    tenantId: string,
    actor: string,
    input: { url: unknown; events: unknown; active?: unknown },
  ): Promise<{ endpoint: EndpointView; secret: string }> {
    const url = await this.checkUrl(input.url);
    const events = asEvents(input.events);
    if (input.active !== undefined && typeof input.active !== 'boolean')
      throw new WebhookError('invalid_input', 'active');
    const id = `whe_${randomUUID()}`;
    const { secret, sealed } = await this.deps.vault.create(tenantId, id);
    const at = this.deps.now().toISOString();
    const endpoint: Endpoint = {
      id,
      tenantId,
      url,
      events,
      active: input.active ?? true,
      disabledReason: null,
      companyRef: newCompanyRef(),
      secretSealed: sealed,
      previousSealed: null,
      previousExpiresAt: null,
      consecutiveFailures: 0,
      version: 1,
      createdAt: at,
      updatedAt: at,
      createdBy: actor,
    };
    if (!(await this.deps.store.createEndpoint(endpoint, MAX_ENDPOINTS)))
      throw new WebhookError('limit_reached');
    return { endpoint: endpointView(endpoint, this.deps.now()), secret };
  }

  public async list(tenantId: string): Promise<readonly EndpointView[]> {
    const now = this.deps.now();
    return (await this.deps.store.endpoints(tenantId)).map((endpoint) =>
      endpointView(endpoint, now),
    );
  }

  public async get(tenantId: string, id: unknown): Promise<EndpointView> {
    return endpointView(await this.load(tenantId, id), this.deps.now());
  }

  private async save(next: Endpoint, expected: number): Promise<EndpointView> {
    if (!(await this.deps.store.saveEndpoint(next, expected)))
      throw new WebhookError('stale_version');
    return endpointView(next, this.deps.now());
  }

  /** Switching an endpoint back on also clears its run of failures. */
  public async update(
    tenantId: string,
    id: unknown,
    input: { version: unknown; url?: unknown; events?: unknown; active?: unknown },
  ): Promise<EndpointView> {
    const current = await this.load(tenantId, id);
    const version = asVersion(input.version);
    if (version !== current.version) throw new WebhookError('stale_version');
    if (input.active !== undefined && typeof input.active !== 'boolean')
      throw new WebhookError('invalid_input', 'active');
    const active = input.active ?? current.active;
    const url = input.url === undefined ? current.url : await this.checkUrl(input.url);
    const reenabled = active && !current.active;
    return this.save(
      {
        ...current,
        url,
        events: input.events === undefined ? current.events : asEvents(input.events),
        active,
        disabledReason: active ? null : current.disabledReason,
        consecutiveFailures: reenabled ? 0 : current.consecutiveFailures,
        version: current.version + 1,
        updatedAt: this.deps.now().toISOString(),
      },
      version,
    );
  }

  /** The new secret is returned once; the old one keeps signing next to it for 24 hours. */
  public async rotate(
    tenantId: string,
    id: unknown,
    version: unknown,
  ): Promise<{ endpoint: EndpointView; secret: string }> {
    const current = await this.load(tenantId, id);
    if (asVersion(version) !== current.version) throw new WebhookError('stale_version');
    const now = this.deps.now();
    const fresh = await this.deps.vault.create(tenantId, current.id);
    // Both secrets are sealed for this endpoint; the old one moves to the "previous" slot.
    const [old] = await this.deps.vault.signing({ ...current, previousSealed: null }, now);
    const endpoint = await this.save(
      {
        ...current,
        secretSealed: fresh.sealed,
        previousSealed: await this.deps.vault.seal(
          tenantId,
          current.id,
          'previous_secret',
          old as string,
        ),
        previousExpiresAt: new Date(now.getTime() + SECRET_GRACE_MS).toISOString(),
        version: current.version + 1,
        updatedAt: now.toISOString(),
      },
      current.version,
    );
    return { endpoint, secret: fresh.secret };
  }

  public async remove(tenantId: string, id: unknown): Promise<void> {
    if (!(await this.deps.store.deleteEndpoint(tenantId, asId(id, 'id'))))
      throw new WebhookError('not_found');
  }

  /** «Enviar prueba»: a signed `ping` to this endpoint only. */
  public async test(tenantId: string, id: unknown): Promise<DeliveryView> {
    const endpoint = await this.load(tenantId, id);
    if (!endpoint.active) throw new WebhookError('invalid_transition');
    const eventId = randomEventId();
    const { store } = this.deps;
    // Fan-out would reach every subscriber: the test is addressed to this endpoint alone.
    const at = this.deps.now().toISOString();
    const body = bodyOf(endpoint, {
      eventId,
      type: PING_EVENT,
      occurredAt: at,
      data: { message: 'ping' },
    });
    const deliveryId = `whd_${randomUUID()}`;
    await store.addDeliveries([
      {
        id: deliveryId,
        tenantId,
        endpointId: endpoint.id,
        eventId,
        eventType: PING_EVENT,
        body,
        createdAt: at,
      },
    ]);
    const created = await store.delivery(tenantId, endpoint.id, deliveryId);
    if (!created) throw new WebhookError('not_found');
    return deliveryView(created);
  }

  public async deliveries(
    tenantId: string,
    id: unknown,
    window: Window,
  ): Promise<Slice<DeliveryView>> {
    const endpoint = await this.load(tenantId, id);
    const slice = await this.deps.store.deliveries(tenantId, endpoint.id, window);
    return { items: slice.items.map(deliveryView), total: slice.total };
  }

  /** Manual retry: a new attempt with the same event id. */
  public async retry(tenantId: string, id: unknown, deliveryId: unknown): Promise<DeliveryView> {
    const endpoint = await this.load(tenantId, id);
    const delivery = await this.deps.store.retryNow(
      tenantId,
      endpoint.id,
      asId(deliveryId, 'deliveryId'),
      this.deps.now().toISOString(),
    );
    if (delivery) return deliveryView(delivery);
    const exists = await this.deps.store.delivery(
      tenantId,
      endpoint.id,
      asId(deliveryId, 'deliveryId'),
    );
    throw new WebhookError(exists ? 'invalid_transition' : 'not_found');
  }
}
