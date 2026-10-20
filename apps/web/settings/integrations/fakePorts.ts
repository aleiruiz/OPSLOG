import type {
  ApiError,
  BffWebhookDelivery,
  BffWebhookEndpoint,
  BffWebhookEvent,
} from '@opslog/contracts';
import type { Result } from '../../app/types';
import type { IntegrationsPorts } from './ports';

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = <T>(status: ApiError['status'], code = 'failure'): Result<T> => ({
  ok: false,
  error: { status, code, message: 'Failure', correlationId: 'corr-fake' },
});

const NOW = '2026-10-19T16:00:00.000Z';
export const MAX_FAKE_ENDPOINTS = 5;

export interface FakeIntegrations extends IntegrationsPorts {
  readonly calls: { readonly name: string; readonly args: readonly unknown[] }[];
  endpoints: BffWebhookEndpoint[];
  deliveriesOf: Record<string, BffWebhookDelivery[]>;
  /** Secrets handed out so far, to check they are never shown again. */
  readonly issued: string[];
  failNext(operation: string, status: number): void;
}

export const demoEndpoint = (over: Partial<BffWebhookEndpoint> = {}): BffWebhookEndpoint => ({
  id: 'wh-1',
  url: 'https://hooks.ejemplo.com/opslog',
  events: ['vehicle.created', 'driver.eligibility_changed'],
  active: true,
  disabled: false,
  companyRef: 'co_demo',
  consecutiveFailures: 0,
  previousSecretUntil: null,
  version: 1,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

export const demoDelivery = (over: Partial<BffWebhookDelivery> = {}): BffWebhookDelivery => ({
  id: 'del-1',
  eventId: 'evt-1',
  eventType: 'vehicle.created',
  status: 'delivered',
  attempts: 1,
  lastStatusCode: 200,
  lastDurationMs: 84,
  lastError: null,
  lastAttemptAt: NOW,
  nextAttemptAt: null,
  createdAt: NOW,
  ...over,
});

/** In-memory integrations with the rules the server enforces: five endpoints, public https only, secret shown once. */
export function createFakeIntegrations(
  options: {
    endpoints?: readonly BffWebhookEndpoint[];
    deliveries?: Record<string, BffWebhookDelivery[]>;
  } = {},
): FakeIntegrations {
  const failures = new Map<string, number>();
  let serial = 0;
  const guard = <T>(name: string, ...args: unknown[]): Result<T> | null => {
    fake.calls.push({ name, args });
    const status = failures.get(name);
    if (status === undefined) return null;
    failures.delete(name);
    return fail<T>(status as ApiError['status']);
  };
  const secret = () => {
    serial += 1;
    const value = `whsec_demo_${serial}_abcdefghijklmnopqrstuvwxyz`;
    fake.issued.push(value);
    return value;
  };
  const find = (id: string) => fake.endpoints.find((item) => item.id === id);
  const replace = (next: BffWebhookEndpoint) => {
    fake.endpoints = fake.endpoints.map((item) => (item.id === next.id ? next : item));
    return next;
  };
  const checkUrl = (url: string) =>
    /^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(url) && !/private|internal|local/i.test(url);
  const fake: FakeIntegrations = {
    calls: [],
    issued: [],
    endpoints: [...(options.endpoints ?? [])],
    deliveriesOf: { ...(options.deliveries ?? {}) },
    failNext: (operation, status) => void failures.set(operation, status),
    list: async () => guard('list') ?? ok({ items: fake.endpoints, max: MAX_FAKE_ENDPOINTS }),
    create: async (input) => {
      const failure = guard<never>('create', input);
      if (failure) return failure;
      if (fake.endpoints.length >= MAX_FAKE_ENDPOINTS) return fail(422, 'rule_violation');
      if (!checkUrl(input.url) || input.events.length === 0) return fail(400, 'invalid_input');
      serial += 1;
      const endpoint = demoEndpoint({
        id: `wh-new-${serial}`,
        url: input.url,
        events: [...input.events] as BffWebhookEvent[],
        active: input.active ?? true,
      });
      fake.endpoints = [...fake.endpoints, endpoint];
      return ok({ endpoint, secret: secret() });
    },
    update: async (id, input) => {
      const failure = guard<never>('update', id, input);
      if (failure) return failure;
      const current = find(id);
      if (!current) return fail(404, 'not_found');
      if (current.version !== input.version) return fail(409, 'conflict');
      if (input.url !== undefined && !checkUrl(input.url)) return fail(400, 'invalid_input');
      return ok(
        replace({
          ...current,
          url: input.url ?? current.url,
          events: input.events ?? current.events,
          active: input.active ?? current.active,
          disabled: input.active ? false : current.disabled,
          consecutiveFailures: input.active ? 0 : current.consecutiveFailures,
          version: current.version + 1,
        }),
      );
    },
    remove: async (id) => {
      const failure = guard<never>('remove', id);
      if (failure) return failure;
      if (!find(id)) return fail(404, 'not_found');
      fake.endpoints = fake.endpoints.filter((item) => item.id !== id);
      return ok(undefined);
    },
    rotate: async (id, version) => {
      const failure = guard<never>('rotate', id, version);
      if (failure) return failure;
      const current = find(id);
      if (!current) return fail(404, 'not_found');
      if (current.version !== version) return fail(409, 'conflict');
      const endpoint = replace({
        ...current,
        version: current.version + 1,
        previousSecretUntil: '2026-10-20T16:00:00.000Z',
      });
      return ok({ endpoint, secret: secret() });
    },
    test: async (id) => {
      const failure = guard<never>('test', id);
      if (failure) return failure;
      const current = find(id);
      if (!current) return fail(404, 'not_found');
      if (!current.active) return fail(409, 'invalid_transition');
      serial += 1;
      const delivery = demoDelivery({
        id: `del-test-${serial}`,
        eventId: `evt-test-${serial}`,
        eventType: 'ping',
        status: 'pending',
        attempts: 0,
        lastStatusCode: null,
        lastDurationMs: null,
        lastAttemptAt: null,
        nextAttemptAt: NOW,
      });
      fake.deliveriesOf[id] = [delivery, ...(fake.deliveriesOf[id] ?? [])];
      return ok(delivery);
    },
    deliveries: async (id, query = {}) => {
      const failure = guard<never>('deliveries', id, query);
      if (failure) return failure;
      if (!find(id)) return fail(404, 'not_found');
      const all = fake.deliveriesOf[id] ?? [];
      const offset = query.offset ?? 0;
      const limit = query.limit ?? 25;
      return ok({ items: all.slice(offset, offset + limit), total: all.length, offset, limit });
    },
    retry: async (id, deliveryId) => {
      const failure = guard<never>('retry', id, deliveryId);
      if (failure) return failure;
      const list = fake.deliveriesOf[id] ?? [];
      const found = list.find((item) => item.id === deliveryId);
      if (!found) return fail(404, 'not_found');
      if (found.status === 'delivered' || found.status === 'pending')
        return fail(409, 'invalid_transition');
      const next = { ...found, status: 'pending' as const, nextAttemptAt: NOW };
      fake.deliveriesOf[id] = list.map((item) => (item.id === deliveryId ? next : item));
      return ok(next);
    },
  };
  return fake;
}
