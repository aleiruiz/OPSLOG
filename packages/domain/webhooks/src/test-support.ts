import { EnvelopePiiCipher, LocalDevKms } from '../../../platform/pii/src/index.js';
import type { AttemptResult, WebhookRequest } from '../../../platform/webhooks/src/index.js';
import { InMemoryWebhookStore } from './memory-store.js';
import { SecretVault } from './secrets.js';
import { WebhookIngest } from './ingest.js';
import { WebhookDispatcher } from './dispatch.js';
import { WebhookService } from './service.js';
import type { PublicEvent } from './types.js';

export const T0 = Date.parse('2026-10-19T12:00:00.000Z');

export class Clock {
  public constructor(public ms = T0) {}
  public now = (): Date => new Date(this.ms);
  public advance(ms: number): void {
    this.ms += ms;
  }
}

/** A receiver that records every request and answers what the test says. */
export class FakeClient {
  public readonly calls: WebhookRequest[] = [];
  public answer: (call: WebhookRequest, index: number) => Partial<AttemptResult> = () => ({});
  public async send(request: WebhookRequest): Promise<AttemptResult> {
    this.calls.push(request);
    return {
      status: 200,
      durationMs: 12,
      failure: null,
      ...this.answer(request, this.calls.length),
    };
  }
}
export const failing = (status = 500): Partial<AttemptResult> => ({
  status,
  failure: 'http',
});

export function world(
  options: {
    perMinute?: number;
    batch?: number;
    tickBudgetMs?: number;
    clock?: () => number;
  } = {},
) {
  const clock = new Clock();
  const store = new InMemoryWebhookStore();
  const vault = new SecretVault(new EnvelopePiiCipher(LocalDevKms.ephemeral('development')));
  const ingest = new WebhookIngest({ store, now: clock.now });
  const checked: string[] = [];
  const service = new WebhookService({
    store,
    vault,
    ingest,
    now: clock.now,
    validateUrl: async (url) => {
      checked.push(url);
      if (!url.startsWith('https://')) {
        const { UrlRejected } = await import('../../../platform/webhooks/src/index.js');
        throw new UrlRejected('not_https');
      }
    },
  });
  const client = new FakeClient();
  const disabled: string[] = [];
  const dispatcher = new WebhookDispatcher({
    store,
    vault,
    client,
    notifier: { disabled: async (_t, id) => void disabled.push(id) },
    now: clock.now,
    random: () => 0.5,
    ...options,
  });
  return { clock, store, vault, ingest, service, client, dispatcher, disabled, checked };
}

export const event = (id: string, type: PublicEvent['type'] = 'vehicle.created'): PublicEvent => ({
  eventId: id,
  type,
  occurredAt: '2026-10-19T12:00:00.000Z',
  data: { vehicleId: 'veh-1', economicNumber: 'E-100', status: 'active' },
});

export async function endpointOf(
  w: ReturnType<typeof world>,
  tenantId = 'tenant-a',
  events: readonly string[] = ['vehicle.created'],
) {
  return w.service.create(tenantId, 'actor-1', { url: 'https://hooks.example.com/in', events });
}
