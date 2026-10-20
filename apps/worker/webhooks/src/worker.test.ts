import { describe, expect, it, vi } from 'vitest';
import {
  EligibilityTracker,
  RETENTION_MS,
  WEBHOOK_EVENTS,
  InMemoryWebhookStore,
  WebhookIngest,
  eventIdOf,
} from '../../../../packages/domain/webhooks/src/index.js';
import { T0, endpointOf, world } from '../../../../packages/domain/webhooks/src/test-support.js';
import {
  WEBHOOKS_DAILY_INTERVAL_MS,
  registerWebhookHandlers,
  sharedRegistry,
  webhookJobs,
  webhookHandlers,
  type WebhookSources,
} from './index.js';

const sources: WebhookSources = {
  vehicle: async (_t, id) => (id === 'gone' ? null : { economicNumber: 'E-100', status: 'active' }),
  incident: async (_t, id) =>
    id === 'gone' ? null : { folio: 'SIN-2026-0007', vehicleId: 'veh-1' },
  order: async (_t, id) => (id === 'gone' ? null : { status: 'in_progress', vehicleId: 'veh-1' }),
};

async function rig() {
  const w = world();
  const { endpoint } = await endpointOf(w, 'tenant-a', [...WEBHOOK_EVENTS]);
  const other = await endpointOf(w, 'tenant-b', [...WEBHOOK_EVENTS]);
  const driver = { id: 'drv-1', eligible: true, reasons: [] as string[] };
  const drivers = {
    driver: async (_t: string, id: string) => (id === 'gone' ? null : driver),
    drivers: async () => [driver],
  };
  const tracker = new EligibilityTracker({
    store: w.store,
    source: drivers,
    ingest: w.ingest,
    now: w.clock.now,
  });
  const handlers = webhookHandlers({
    ingest: w.ingest,
    tracker,
    drivers,
    sources,
    now: w.clock.now,
  });
  const run = (type: string, payload: unknown, eventId = 'out-1', tenantId = 'tenant-a') =>
    handlers[type]?.(payload, { eventId, tenantId, type });
  const bodies = async (id = endpoint.id, tenantId = 'tenant-a') =>
    (await w.store.deliveries(tenantId, id, { limit: 50, offset: 0 })).items.map((d) =>
      JSON.parse(d.body),
    );
  return { w, run, bodies, endpoint, other, tracker, driver };
}

const CASES: [string, Record<string, unknown>, Record<string, unknown>][] = [
  [
    'vehicle.created',
    { vehicleId: 'veh-1', version: 1 },
    { vehicleId: 'veh-1', economicNumber: 'E-100', status: 'active' },
  ],
  [
    'vehicle.updated',
    { vehicleId: 'veh-1', version: 2 },
    { vehicleId: 'veh-1', economicNumber: 'E-100', status: 'active' },
  ],
  [
    'vehicle.status_changed',
    { vehicleId: 'veh-1', status: 'out_of_service', version: 3 },
    { vehicleId: 'veh-1', economicNumber: 'E-100', status: 'out_of_service' },
  ],
  ['driver.created', { driverId: 'drv-1', version: 1 }, { driverId: 'drv-1', eligible: true }],
  ['driver.updated', { driverId: 'drv-1', version: 2 }, { driverId: 'drv-1', eligible: true }],
  [
    'incident.created',
    { incidentId: 'inc-1', vehicleId: 'veh-1', version: 1 },
    { incidentId: 'inc-1', folio: 'SIN-2026-0007', vehicleId: 'veh-1' },
  ],
  [
    'incident.status_changed',
    { incidentId: 'inc-1', vehicleId: 'veh-1', version: 2, status: 'repair' },
    { incidentId: 'inc-1', folio: 'SIN-2026-0007', vehicleId: 'veh-1', status: 'repair' },
  ],
  [
    'incident.closed',
    { incidentId: 'inc-1', vehicleId: 'veh-1', version: 3 },
    { incidentId: 'inc-1', folio: 'SIN-2026-0007', vehicleId: 'veh-1', status: 'closed' },
  ],
  [
    'maintenance.created',
    { orderId: 'ord-1', vehicleId: 'veh-1', version: 1 },
    { orderId: 'ord-1', vehicleId: 'veh-1', status: 'in_progress' },
  ],
  [
    'maintenance.status_changed',
    { orderId: 'ord-1', vehicleId: 'veh-1', version: 2 },
    { orderId: 'ord-1', vehicleId: 'veh-1', status: 'in_progress' },
  ],
];

describe('webhook handlers', () => {
  it.each(CASES)(
    '%s becomes a public event with ids, folios and states only',
    async (type, payload, data) => {
      const { run, bodies, endpoint, other } = await rig();
      await run(type, payload);
      const [body] = await bodies();
      expect(body).toMatchObject({ type, schemaVersion: 1, companyRef: endpoint.companyRef, data });
      expect(body.id).toBe(eventIdOf('tenant-a', `out-1:${type}`));
      // No internal company id, no money, no personal data anywhere in the body.
      const text = JSON.stringify(body);
      expect(text).not.toMatch(/tenant-a|tenant-b|amount|cost|plate|vin|email|phone|license|name/i);
      // The other company's endpoint never receives it.
      expect(await bodies(other.endpoint.id, 'tenant-b')).toEqual([]);
    },
  );

  it('covers every public event of the catalog except the derived one', () => {
    const handled = CASES.map(([type]) => type);
    expect(WEBHOOK_EVENTS.filter((e) => !handled.includes(e))).toEqual([
      'driver.eligibility_changed',
    ]);
  });

  it('a repeated outbox event creates one delivery per endpoint', async () => {
    const { run, bodies } = await rig();
    await run('vehicle.created', { vehicleId: 'veh-1', version: 1 }, 'same');
    await run('vehicle.created', { vehicleId: 'veh-1', version: 1 }, 'same');
    await run('vehicle.created', { vehicleId: 'veh-1', version: 1 }, 'different');
    expect(await bodies()).toHaveLength(2);
  });

  it('drops an event whose record is gone and refuses a malformed payload', async () => {
    const { run, bodies } = await rig();
    await run('vehicle.created', { vehicleId: 'gone', version: 1 });
    await run('incident.closed', { incidentId: 'gone', vehicleId: 'v', version: 1 });
    await run('maintenance.created', { orderId: 'gone', vehicleId: 'v', version: 1 });
    await run('driver.updated', { driverId: 'gone', version: 1 });
    expect(await bodies()).toEqual([]);
    for (const [type, payload] of [
      ['vehicle.created', null],
      ['vehicle.created', []],
      ['vehicle.created', { vehicleId: 'v' }],
      ['vehicle.created', { vehicleId: 'v', version: 1, extra: 'x' }],
      ['vehicle.created', { vehicleId: 'bad id!', version: 1 }],
      ['vehicle.created', { vehicleId: 'v', version: -1 }],
      ['vehicle.status_changed', { vehicleId: 'v', status: 'Bad Status', version: 1 }],
      ['vehicle.status_changed', { vehicleId: 'v', status: 5, version: 1 }],
    ] as const)
      await expect(run(type, payload)).rejects.toThrow('invalid webhook event');
  });

  it('a driver event also asks the tracker, which announces the eligibility change once', async () => {
    const { run, bodies, driver, tracker } = await rig();
    await run('driver.created', { driverId: 'drv-1', version: 1 }, 'o1');
    driver.eligible = false;
    driver.reasons = ['license_expired'];
    await run('driver.updated', { driverId: 'drv-1', version: 2 }, 'o2');
    await tracker.check('tenant-a', 'drv-1');
    const changes = (await bodies()).filter((b) => b.type === 'driver.eligibility_changed');
    expect(changes).toHaveLength(1);
    expect(changes[0].data).toEqual({
      driverId: 'drv-1',
      eligible: false,
      reasons: ['license_expired'],
    });
    expect(JSON.stringify(changes[0])).not.toMatch(/tenant-a/);
  });

  it('registers one handler per public event except the derived one', () => {
    const registered: string[] = [];
    registerWebhookHandlers(
      { register: (type) => void registered.push(type) },
      {
        ingest: new WebhookIngest({ store: new InMemoryWebhookStore(), now: () => new Date(T0) }),
        tracker: { check: async () => false },
        drivers: { driver: async () => null },
        sources,
        now: () => new Date(T0),
      },
    );
    expect(registered.sort()).toEqual(CASES.map(([type]) => type).sort());
  });
});

describe('shared registry', () => {
  it('runs every handler of a type and throws the first failure after all ran', async () => {
    const real = new Map<string, (p: unknown, e: never) => Promise<void>>();
    const registry = sharedRegistry({
      register: (type, handler) => void real.set(type, handler as never),
    });
    const calls: string[] = [];
    registry.register('x', async () => void calls.push('one'));
    registry.register('x', async () => {
      calls.push('two');
      throw new Error('first');
    });
    registry.register('x', async () => {
      calls.push('three');
      throw new Error('second');
    });
    registry.register('y', async () => void calls.push('y'));
    await expect(real.get('x')?.({}, {} as never)).rejects.toThrow('first');
    expect(calls).toEqual(['one', 'two', 'three']);
    expect([...real.keys()]).toEqual(['x', 'y']);
    await real.get('y')?.({}, {} as never);
    const ok = sharedRegistry({
      register: (type, handler) => void real.set(`ok-${type}`, handler as never),
    });
    ok.register('z', async () => undefined);
    await expect(real.get('ok-z')?.({}, {} as never)).resolves.toBeUndefined();
  });
});

describe('jobs', () => {
  const make = (clock: { ms: number }, failing: string[] = []) => {
    const dispatched: string[] = [];
    const jobs = webhookJobs({
      dispatcher: {
        runDue: async (t) => {
          if (failing.includes(t)) throw new Error(`boom ${t}`);
          dispatched.push(t);
          return { delivered: 1, retried: 2, deadLettered: 3 };
        },
      },
      tracker: { scan: vi.fn(async () => 2) },
      store: { purge: vi.fn(async () => 5) },
      activeTenantIds: () => ['a', 'b'],
      clock: () => clock.ms,
    });
    return { jobs, dispatched };
  };

  it('dispatches for every active company and reports the work done', async () => {
    const { jobs, dispatched } = make({ ms: T0 });
    expect(jobs.map((j) => j.name)).toEqual([
      'webhooks.dispatch',
      'webhooks.eligibility',
      'webhooks.purge',
    ]);
    expect(await jobs[0]?.run()).toBe(12);
    expect(dispatched).toEqual(['a', 'b']);
  });

  it('a failing company does not stop the others; the failure is thrown at the end', async () => {
    const { jobs, dispatched } = make({ ms: T0 }, ['a']);
    await expect(jobs[0]?.run()).rejects.toThrow('boom a');
    expect(dispatched).toEqual(['b']);
  });

  it('scans eligibility and purges at most once an hour', async () => {
    const clock = { ms: T0 };
    const { jobs } = make(clock);
    expect(await jobs[1]?.run()).toBe(4);
    expect(await jobs[1]?.run()).toBe(0);
    expect(await jobs[2]?.run()).toBe(10);
    clock.ms += WEBHOOKS_DAILY_INTERVAL_MS;
    expect(await jobs[1]?.run()).toBe(4);
    expect(RETENTION_MS).toBe(30 * 86_400_000);
  });
});
