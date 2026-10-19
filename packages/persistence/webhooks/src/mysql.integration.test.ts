import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import {
  DISABLE_AFTER_FAILURES,
  MAX_ENDPOINTS,
  SecretVault,
  WebhookDispatcher,
  WebhookIngest,
  WebhookService,
  type Endpoint,
  type NewDelivery,
} from '../../../domain/webhooks/src/index.js';
import { EnvelopePiiCipher, LocalDevKms } from '../../../platform/pii/src/index.js';
import type { AttemptResult, WebhookRequest } from '../../../platform/webhooks/src/index.js';
import { WEBHOOK_TABLES as T } from './entities.js';
import { TypeOrmWebhookStore } from './store.js';
import { adminUrl, startWebhookDatabase, type WebhookDatabase } from './test-support/mysql.js';

const suite = adminUrl ? describe : describe.skip;
const A = 'tenant-a';
const B = 'tenant-b';
const T0 = new Date('2026-10-19T16:00:00.000Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

const endpoint = (id: string, tenantId = A, over: Partial<Endpoint> = {}): Endpoint => ({
  id,
  tenantId,
  url: 'https://hooks.example.com/in',
  events: ['vehicle.created'],
  active: true,
  disabledReason: null,
  companyRef: `co_${id}`,
  secretSealed: 'pii1.a.b.c.d',
  previousSealed: null,
  previousExpiresAt: null,
  consecutiveFailures: 0,
  version: 1,
  createdAt: at(0).toISOString(),
  updatedAt: at(0).toISOString(),
  createdBy: 'ana',
  ...over,
});
const delivery = (id: string, endpointId: string, eventId: string, tenantId = A): NewDelivery => ({
  id,
  tenantId,
  endpointId,
  eventId,
  eventType: 'vehicle.created',
  body: `{"id":"${eventId}"}`,
  createdAt: at(0).toISOString(),
});

suite('persistent webhooks on MySQL', () => {
  let db: WebhookDatabase;
  let source: DataSource;
  let store: TypeOrmWebhookStore;

  beforeAll(async () => {
    db = await startWebhookDatabase('webhooks');
    source = await db.openRuntime();
    store = new TypeOrmWebhookStore(source);
  }, 60_000);
  afterAll(async () => {
    await db?.close();
  });

  it('caps a company at its limit even when the creations race', async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        store.createEndpoint(endpoint(`race-${i}`, 'tenant-race'), MAX_ENDPOINTS),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(MAX_ENDPOINTS);
    expect(await store.endpoints('tenant-race')).toHaveLength(MAX_ENDPOINTS);
    // Another company has its own five.
    expect(await store.createEndpoint(endpoint('other', 'tenant-other'), MAX_ENDPOINTS)).toBe(true);
  });

  it('reads, versions and isolates endpoints by company', async () => {
    expect(await store.createEndpoint(endpoint('ep1'), MAX_ENDPOINTS)).toBe(true);
    expect(await store.createEndpoint(endpoint('epb', B), MAX_ENDPOINTS)).toBe(true);
    expect(await store.endpoint(B, 'ep1')).toBeNull();
    expect((await store.endpoint(A, 'ep1'))?.events).toEqual(['vehicle.created']);
    const current = (await store.endpoint(A, 'ep1')) as Endpoint;
    const next = {
      ...current,
      url: 'https://new.example.com/x',
      events: ['driver.created' as const],
      version: 2,
    };
    expect(await store.saveEndpoint(next, 5)).toBe(false);
    expect(await store.saveEndpoint({ ...next, tenantId: B }, 1)).toBe(false);
    expect(await store.saveEndpoint(next, 1)).toBe(true);
    expect(await store.saveEndpoint(next, 1)).toBe(false);
    expect(await store.endpoint(A, 'ep1')).toMatchObject({
      url: 'https://new.example.com/x',
      version: 2,
      events: ['driver.created'],
    });
    expect(await store.deleteEndpoint(B, 'ep1')).toBe(false);
  });

  it('creates one delivery per endpoint and event, and orders the history newest first', async () => {
    await store.createEndpoint(endpoint('ep2'), 99);
    expect(
      await store.addDeliveries([delivery('d1', 'ep2', 'evt_1'), delivery('d2', 'ep2', 'evt_2')]),
    ).toBe(2);
    expect(await store.addDeliveries([delivery('d1x', 'ep2', 'evt_1')])).toBe(0);
    expect(await db.rows(`SELECT id FROM \`${T.deliveries}\` WHERE id = 'd1x'`)).toEqual([]);
    const page = await store.deliveries(A, 'ep2', { limit: 1, offset: 0 });
    expect(page.total).toBe(2);
    expect(page.items[0]?.id).toBe('d2');
    expect((await store.deliveries(B, 'ep2', { limit: 5, offset: 0 })).total).toBe(0);
    expect(await store.delivery(B, 'ep2', 'd1')).toBeNull();
    expect(await store.delivery(A, 'other-endpoint', 'd1')).toBeNull();
  });

  it('two connections claiming the same delivery: exactly one owns it', async () => {
    await store.createEndpoint(endpoint('ep3'), 99);
    await store.addDeliveries([delivery('c1', 'ep3', 'evt_c1')]);
    const second = new TypeOrmWebhookStore(await db.openRuntime());
    const now = at(10);
    const claims = await Promise.all(
      Array.from({ length: 6 }, (_, i) => (i % 2 ? store : second).claimDue(A, now, 60_000, 50)),
    );
    const mine = claims.flat().filter((work) => work.delivery.id === 'c1');
    expect(mine).toHaveLength(1);
    expect(mine[0]?.endpoint.id).toBe('ep3');
    // Nothing else is due for a claimed delivery until its lease ends.
    expect(
      (await store.claimDue(A, at(11), 60_000, 50)).filter((w) => w.delivery.id === 'c1'),
    ).toEqual([]);
    expect(await store.claimDue(B, at(11), 60_000, 50)).toEqual([]);
  });

  it('settles only under its own lease, and renewal moves the lease', async () => {
    await store.createEndpoint(endpoint('ep4'), 99);
    await store.addDeliveries([delivery('s1', 'ep4', 'evt_s1')]);
    const [work] = (await store.claimDue(A, at(20), 30_000, 50)).filter(
      (w) => w.delivery.id === 's1',
    );
    const lease = work?.delivery.leaseUntil as string;
    expect(await store.renew(A, 's1', 'someone-else', at(21), 30_000)).toBeNull();
    expect(await store.renew(B, 's1', lease, at(21), 30_000)).toBeNull();
    const renewed = await store.renew(A, 's1', lease, at(21), 90_000);
    expect(renewed).toBe(at(111).toISOString());
    const outcome = { kind: 'delivered', statusCode: 204, durationMs: 31 } as const;
    expect(await store.settle(A, 's1', outcome, at(22).toISOString(), lease)).toBe(false);
    expect(await store.settle(B, 's1', outcome, at(22).toISOString(), renewed)).toBe(false);
    expect(await store.settle(A, 's1', outcome, at(22).toISOString(), renewed)).toBe(true);
    expect(await store.settle(A, 's1', outcome, at(23).toISOString(), renewed)).toBe(false);
    expect(await store.delivery(A, 'ep4', 's1')).toMatchObject({
      status: 'delivered',
      attempts: 1,
      lastStatusCode: 204,
      lastDurationMs: 31,
      leaseUntil: null,
      nextAttemptAt: null,
    });
  });

  it('retry, dead letter and manual retry keep the same event id and count attempts', async () => {
    await store.createEndpoint(endpoint('ep5'), 99);
    await store.addDeliveries([delivery('r1', 'ep5', 'evt_r1')]);
    const [work] = (await store.claimDue(A, at(30), 30_000, 50)).filter(
      (w) => w.delivery.id === 'r1',
    );
    expect(
      await store.settle(
        A,
        'r1',
        {
          kind: 'retry',
          statusCode: 503,
          durationMs: 9,
          error: 'http_503',
          nextAttemptAt: at(90).toISOString(),
        },
        at(31).toISOString(),
        work?.delivery.leaseUntil ?? null,
      ),
    ).toBe(true);
    expect(await store.delivery(A, 'ep5', 'r1')).toMatchObject({
      status: 'failed',
      attempts: 1,
      lastError: 'http_503',
      nextAttemptAt: at(90).toISOString(),
    });
    expect(
      (await store.claimDue(A, at(60), 30_000, 50)).filter((w) => w.delivery.id === 'r1'),
    ).toEqual([]);
    const [again] = (await store.claimDue(A, at(91), 30_000, 50)).filter(
      (w) => w.delivery.id === 'r1',
    );
    expect(
      await store.settle(
        A,
        'r1',
        { kind: 'dead_letter', statusCode: null, durationMs: 3, error: 'timeout' },
        at(92).toISOString(),
        again?.delivery.leaseUntil ?? null,
      ),
    ).toBe(true);
    expect(await store.retryNow(B, 'ep5', 'r1', at(100).toISOString())).toBeNull();
    const manual = await store.retryNow(A, 'ep5', 'r1', at(100).toISOString());
    expect(manual).toMatchObject({
      status: 'pending',
      manual: true,
      eventId: 'evt_r1',
      attempts: 2,
    });
    expect(await store.retryNow(A, 'ep5', 'r1', at(101).toISOString())).toBeNull();
    const [last] = (await store.claimDue(A, at(101), 30_000, 50)).filter(
      (w) => w.delivery.id === 'r1',
    );
    expect(last?.delivery.manual).toBe(true);
  });

  it('does not claim the deliveries of a switched-off endpoint', async () => {
    await store.createEndpoint(endpoint('ep6', A, { active: false }), 99);
    await store.addDeliveries([delivery('o1', 'ep6', 'evt_o1')]);
    expect(
      (await store.claimDue(A, at(200), 30_000, 50)).filter((w) => w.delivery.id === 'o1'),
    ).toEqual([]);
  });

  it('counts the attempts of the last minute and switches an endpoint off exactly once', async () => {
    await store.createEndpoint(endpoint('ep7'), 99);
    await store.addDeliveries([delivery('w1', 'ep7', 'evt_w1'), delivery('w2', 'ep7', 'evt_w2')]);
    await store.claimDue(A, at(300), 30_000, 2);
    expect(await store.attemptsSince(A, at(299))).toBeGreaterThanOrEqual(2);
    expect(await store.attemptsSince(A, at(301))).toBe(0);
    expect(await store.attemptsSince(B, at(0))).toBe(0);
    const outcomes = [];
    for (let i = 0; i < DISABLE_AFTER_FAILURES + 3; i += 1)
      outcomes.push((await store.noteResult(A, 'ep7', false, at(400).toISOString())).disabled);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(outcomes.indexOf(true)).toBe(DISABLE_AFTER_FAILURES - 1);
    expect(await store.endpoint(A, 'ep7')).toMatchObject({
      active: false,
      disabledReason: 'failures',
    });
    await store.noteResult(A, 'ep7', true, at(401).toISOString());
    expect((await store.endpoint(A, 'ep7'))?.consecutiveFailures).toBe(0);
    expect(await store.noteResult(B, 'ep7', false, at(402).toISOString())).toEqual({
      disabled: false,
    });
  });

  it('purges old deliveries per company and deletes an endpoint with its history', async () => {
    await store.createEndpoint(endpoint('ep8'), 99);
    await store.createEndpoint(endpoint('ep8b', B), 99);
    await store.addDeliveries([
      delivery('p1', 'ep8', 'evt_p1'),
      delivery('p2', 'ep8b', 'evt_p2', B),
    ]);
    expect(await store.purge(A, at(-1))).toBe(0);
    expect(await store.purge(A, at(1))).toBeGreaterThan(0);
    expect((await store.deliveries(A, 'ep8', { limit: 5, offset: 0 })).total).toBe(0);
    expect((await store.deliveries(B, 'ep8b', { limit: 5, offset: 0 })).total).toBe(1);
    await store.addDeliveries([delivery('p3', 'ep8', 'evt_p3')]);
    expect(await store.deleteEndpoint(A, 'ep8')).toBe(true);
    expect(await db.rows(`SELECT id FROM \`${T.deliveries}\` WHERE endpoint_id = 'ep8'`)).toEqual(
      [],
    );
    expect(await store.deleteEndpoint(A, 'ep8')).toBe(false);
  });

  it('keeps the last known eligibility per driver and company', async () => {
    expect(await store.driverState(A, 'drv-1')).toBeNull();
    await store.saveDriverState({
      tenantId: A,
      driverId: 'drv-1',
      eligible: true,
      transitions: 0,
      updatedAt: at(0).toISOString(),
    });
    await store.saveDriverState({
      tenantId: A,
      driverId: 'drv-1',
      eligible: false,
      transitions: 1,
      updatedAt: at(5).toISOString(),
    });
    expect(await store.driverState(A, 'drv-1')).toMatchObject({ eligible: false, transitions: 1 });
    expect(await store.driverState(B, 'drv-1')).toBeNull();
  });

  it('the account cannot touch another table or change the schema', async () => {
    await expect(source.query('SELECT 1 FROM `mysql`.`user` LIMIT 1')).rejects.toThrow();
    await expect(source.query(`DROP TABLE \`${T.driverState}\``)).rejects.toThrow();
  });

  it('end to end: the secret is stored sealed and the cadence runs on the real store', async () => {
    const clock = { ms: T0.getTime() };
    const now = () => new Date(clock.ms);
    const vault = new SecretVault(new EnvelopePiiCipher(LocalDevKms.ephemeral('development')));
    const ingest = new WebhookIngest({ store, now });
    const service = new WebhookService({
      store,
      vault,
      ingest,
      now,
      validateUrl: async () => undefined,
    });
    const created = await service.create('tenant-e2e', 'ana', {
      url: 'https://hooks.example.com/in',
      events: ['vehicle.created'],
    });
    const [row] = await db.rows<Record<string, unknown>>(
      `SELECT * FROM \`${T.endpoints}\` WHERE company_id = 'tenant-e2e'`,
    );
    expect(String(row?.secret_sealed)).toMatch(/^pii1\./);
    expect(JSON.stringify(row)).not.toContain(created.secret);
    const calls: WebhookRequest[] = [];
    const answer: { result: Partial<AttemptResult> } = { result: { status: 500, failure: 'http' } };
    const dispatcher = new WebhookDispatcher({
      store,
      vault,
      notifier: { disabled: async () => undefined },
      now,
      random: () => 0.5,
      client: {
        send: async (request) => {
          calls.push(request);
          return { status: 200, durationMs: 5, failure: null, ...answer.result };
        },
      },
    });
    await ingest.publish('tenant-e2e', {
      eventId: 'evt_e2e',
      type: 'vehicle.created',
      occurredAt: now().toISOString(),
      data: { vehicleId: 'v1' },
    });
    const waits = [60_000, 300_000, 1_800_000, 7_200_000, 43_200_000];
    for (let i = 0; i <= waits.length; i += 1) {
      await dispatcher.runDue('tenant-e2e');
      clock.ms += (waits[i] ?? 0) + 1;
    }
    const final = (
      await store.deliveries('tenant-e2e', created.endpoint.id, { limit: 5, offset: 0 })
    ).items[0];
    expect(final).toMatchObject({ status: 'dead_letter', attempts: 6, lastError: 'http_500' });
    expect(calls).toHaveLength(6);
    expect(
      calls.every((call) => call.eventId === 'evt_e2e' && call.secrets[0] === created.secret),
    ).toBe(true);
    answer.result = {};
    await service.retry('tenant-e2e', created.endpoint.id, final?.id);
    await dispatcher.runDue('tenant-e2e');
    expect(calls).toHaveLength(7);
    expect(
      await store.delivery('tenant-e2e', created.endpoint.id, final?.id as string),
    ).toMatchObject({ status: 'delivered', attempts: 7 });
  });
});
