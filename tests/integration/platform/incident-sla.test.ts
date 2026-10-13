import { afterAll, describe, expect, it, vi } from 'vitest';
import { EnvelopePiiCipher, LocalDevKms } from '../../../packages/platform/pii/src/index.js';
import {
  InMemoryOutboxStore,
  createPlatform,
  type Platform,
} from '../../../apps/api/composition/src/index.js';
import { FakeOidcVerifier } from '../../../apps/api/composition/src/index.js';
import {
  createBffWorld,
  type BffWorld,
  type Browser,
} from '../../../apps/api/bff/src/test-support.js';
import { TestSinkMailer } from '../../../apps/worker/incident-sla/src/index.js';
import { InMemoryIncidentSlaStore } from '../../../packages/domain/incidents/sla/src/index.js';
import { defineSlaScenarios } from './incident-sla-scenarios.js';
import {
  Cases,
  DAY,
  FlakyMailer,
  P,
  T0,
  after,
  alertsOf,
  drainAll,
  kindsOf,
  type SlaEnv,
} from './incident-sla-support.js';

/** Fails the next outbox transaction: the outbox going down in the middle of a scan. */
class FlakyOutbox extends InMemoryOutboxStore {
  public failing = false;
  public override transaction(...args: any[]): any {
    if (this.failing) throw new Error('outbox down');
    return (super.transaction as (...a: unknown[]) => unknown)(...args);
  }
}

interface Fixture {
  readonly world: BffWorld;
  readonly env: SlaEnv;
  readonly outbox: FlakyOutbox;
  readonly mailer: FlakyMailer;
  readonly cases: Cases;
  readonly admin: () => Browser;
}
const worlds: BffWorld[] = [];
afterAll(() => worlds.forEach((world) => world.dispose()));

/** One platform, two companies: A with a manager (the responsible), an admin and a viewer. */
async function fixture(): Promise<Fixture> {
  const mailer = new FlakyMailer();
  const mailerB = mailer;
  const outbox = new FlakyOutbox(() => Date.now());
  const world = createBffWorld({ adapters: { incidentAlertMailer: mailer, outbox } });
  worlds.push(world);
  const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
  const b = await world.tenant('Empresa Beta', 'subject-admin-b');
  const manager = await world.member('subject-admin-a', 'incident_manager', 'subject-manager-a');
  await world.member('subject-admin-a', 'viewer', 'subject-viewer-a');
  const managerB = await world.member('subject-admin-b', 'incident_manager', 'subject-manager-b');
  const who = {
    admin: await world.loginAs('subject-admin-a'),
    manager: await world.loginAs('subject-manager-a'),
    viewer: await world.loginAs('subject-viewer-a'),
    adminB: await world.loginAs('subject-admin-b'),
    managerB: await world.loginAs('subject-manager-b'),
  };
  const vehicleOf = async (admin: Browser, tag: string) => {
    const area = await admin.post('/api/areas', { json: { name: `Flota ${tag}` } });
    const vehicle = await admin.post('/api/vehicles', {
      json: {
        economicNumber: `SLA-${tag}`,
        plate: `SL${tag}`,
        make: 'Nissan',
        model: 'NP300',
        year: 2023,
        areaId: area.json.id,
        odometerKm: 5000,
      },
    });
    expect(vehicle.status, vehicle.text).toBe(201);
    return vehicle.json.id as string;
  };
  const vehicleA = await vehicleOf(who.admin, '01');
  const vehicleB = await vehicleOf(who.adminB, '02');
  let revoked = false;
  const relog = async () => {
    who.admin = await world.loginAs('subject-admin-a');
    if (!revoked) who.manager = await world.loginAs('subject-manager-a');
    who.viewer = await world.loginAs('subject-viewer-a');
    who.adminB = await world.loginAs('subject-admin-b');
    who.managerB = await world.loginAs('subject-manager-b');
  };
  const env: SlaEnv = {
    platform: world.platform,
    platformB: world.platform,
    tenantA: a.tenantId,
    tenantB: b.tenantId,
    vehicleA,
    vehicleB,
    managerId: manager.identityId,
    managerBId: managerB.identityId,
    mailer,
    mailerB,
    manager: () => who.manager,
    admin: () => who.admin,
    viewer: () => who.viewer,
    managerB: () => who.managerB,
    adminB: () => who.adminB,
    at: async (date) => {
      vi.setSystemTime(date);
      await relog();
    },
    revokeManager: async () => {
      const login = await world.platform.signIn(await world.principal('subject-admin-a'));
      expect(login.ok).toBe(true);
      const removed = await world.platform.removeMember(
        login.value?.token as string,
        'revoke-fixture',
        manager.identityId,
      );
      expect(removed.ok, JSON.stringify(removed.error)).toBe(true);
      revoked = true;
    },
    queueAssigned: async (incidentId, version) => {
      await world.platform.outbox.transaction((tx) => {
        const eventId = `evt-manual-assigned-${incidentId}`;
        tx.enqueue({
          eventId,
          tenantId: env.tenantA,
          type: 'incident.assigned',
          payload: { incidentId, version },
          occurredAt: new Date().toISOString(),
          idempotencyKey: eventId,
          actorRef: { subject: 'system:incident-sla', kind: 'system' },
          entityId: incidentId,
          schemaVersion: 1,
        });
      });
    },
    alertEvents: async (tenantId, incidentId) =>
      (await world.platform.outbox.all()).filter(
        (r) =>
          r.tenantId === tenantId && r.type === 'incident.sla_alert' && r.entityId === incidentId,
      ).length,
    dump: async (tenantId) => {
      const store = world.platform.incidentSlaModule.store as InMemoryIncidentSlaStore;
      const deliveries = await Promise.all(
        store.all(tenantId).map((alert) => store.deliveries(tenantId, alert.id)),
      );
      return JSON.stringify([
        (await world.platform.outbox.all()).filter((r) => r.tenantId === tenantId),
        deliveries,
      ]);
    },
  };
  return {
    world,
    env,
    outbox,
    mailer,
    cases: new Cases(env.manager, env.admin, vehicleA, manager.identityId, 'x'),
    admin: env.admin,
  };
}

defineSlaScenarios('in-memory composition', async () => (await fixture()).env);

describe('in-memory composition: jobs, settings, atomicity, capacity and production', () => {
  it('runs a scan job with the claimed tenant, refuses a tenant in the payload or extra keys, a suspended tenant and an actor who lost the permission (acceptance 9)', async () => {
    const { env, world } = await fixture();
    const platform = world.platform;
    const scan = vi.spyOn(platform.incidentSlaModule.scanner, 'scan');
    const enqueue = (over: Record<string, unknown>) => {
      const eventId = `job-${Math.random().toString(36).slice(2)}`;
      platform.outbox.transaction((tx) =>
        tx.enqueue({
          eventId,
          tenantId: env.tenantA,
          type: 'incident.sla.scan',
          payload: {},
          occurredAt: new Date().toISOString(),
          idempotencyKey: eventId,
          ...over,
        }),
      );
      return eventId;
    };
    const status = async (tenantId: string, eventId: string) =>
      (await platform.outbox.get(tenantId, eventId))?.status;
    const exhaust = async (tenantId: string, eventId: string) => {
      for (let round = 0; round < 8; round += 1) {
        await drainAll(platform);
        if ((await status(tenantId, eventId)) === 'dead_letter') return;
        vi.setSystemTime(new Date(Date.now() + 13 * 3_600_000));
      }
    };
    const system = { subject: 'system:test', kind: 'system' } as const;
    const good = enqueue({ actorRef: system });
    await drainAll(platform);
    expect(scan).toHaveBeenCalledExactlyOnceWith(env.tenantA, undefined);
    expect(await status(env.tenantA, good)).toBe('delivered');
    scan.mockClear();
    const withTenant = enqueue({ payload: { tenantId: env.tenantB }, actorRef: system });
    const extra = enqueue({ payload: { incidentId: 'inc-1', extra: 1 }, actorRef: system });
    const nested = enqueue({ payload: [], actorRef: system });
    for (const id of [withTenant, extra, nested]) await exhaust(env.tenantA, id);
    expect(scan).not.toHaveBeenCalled();
    for (const id of [withTenant, extra, nested])
      expect(await status(env.tenantA, id)).toBe('dead_letter');
    // A manual job of an actor who has no incident rights ends without reading anything.
    const viewer = await world.platform.signIn(await world.principal('subject-viewer-a'));
    const viewerId = (await world.platform.session(viewer.value?.token as string, 'c')).value?.actor
      .subject as string;
    const rejected = platform.runtime.worker.metrics.rejectedActors;
    const manual = enqueue({
      actorRef: { subject: `user-${viewerId}`, kind: 'user' },
      requiredPermission: 'incidents:edit',
    });
    await drainAll(platform);
    expect(scan).not.toHaveBeenCalled();
    expect(platform.runtime.worker.metrics.rejectedActors).toBe(rejected + 1);
    expect(await status(env.tenantA, manual)).toBe('dead_letter');
    // A suspended tenant's job never runs.
    const queued = enqueue({ tenantId: env.tenantB, actorRef: system });
    await platform.suspendTenant(env.tenantB);
    await drainAll(platform);
    expect(scan).not.toHaveBeenCalled();
    expect(await status(env.tenantB, queued)).toBe('dead_letter');
  });

  it('validates the SLA settings: 0 and 366 are a 400, a stale version a 409, defaults without a saved configuration (acceptance 11)', async () => {
    const { env } = await fixture();
    const admin = env.admin();
    const put = (json: Record<string, unknown>) =>
      admin.put('/api/alerts/settings', {
        json: { expiryWindowDays: 30, recipientRoles: ['admin'], ...json },
      });
    const initial = await admin.get('/api/alerts/settings');
    expect(initial.json).toMatchObject({
      version: 0,
      incidentSlaDays: { critical: 7, high: 15, medium: 30, low: 45 },
      incidentInactivityDays: 5,
    });
    const days = (over: Record<string, number>) => ({
      critical: 7,
      high: 15,
      medium: 30,
      low: 45,
      ...over,
    });
    for (const bad of [
      { incidentSlaDays: days({ critical: 0 }) },
      { incidentSlaDays: days({ critical: 366 }) },
      { incidentSlaDays: days({ high: 1.5 }) },
      { incidentSlaDays: { critical: 7 } },
      { incidentInactivityDays: 0 },
      { incidentInactivityDays: 61 },
    ])
      expect((await put({ version: 0, ...bad })).status, JSON.stringify(bad)).toBe(400);
    const saved = await put({
      version: 0,
      incidentSlaDays: days({ critical: 3 }),
      incidentInactivityDays: 2,
    });
    expect(saved.status, saved.text).toBe(200);
    expect(saved.json).toMatchObject({
      version: 1,
      incidentSlaDays: { critical: 3, high: 15, medium: 30, low: 45 },
      incidentInactivityDays: 2,
    });
    expect((await put({ version: 0, incidentInactivityDays: 9 })).status).toBe(409);
    // Omitted fields keep what is stored.
    const kept = await put({ version: 1 });
    expect(kept.json).toMatchObject({
      incidentInactivityDays: 2,
      incidentSlaDays: { critical: 3 },
    });
    // The new target applies to the next cycle: a critical case now has 3 days.
    const item = await new Cases(env.manager, env.admin, env.vehicleA, env.managerId, 's').assigned(
      'critical',
    );
    expect(
      (await new Cases(env.manager, env.admin, env.vehicleA, env.managerId, 's').detail(item)).sla,
    ).toMatchObject({ targetDays: 3 });
  });

  it('leaves no notice when the outbox fails and creates it once on the next scan (acceptance 12)', async () => {
    const { env, outbox, cases } = await fixture();
    await env.at(T0);
    const item = await cases.assigned('high');
    await env.at(after(T0, 12 * DAY));
    const store = env.platform.incidentSlaModule.store as InMemoryIncidentSlaStore;
    outbox.failing = true;
    await expect(env.platform.incidentSlaModule.scanner.scan(env.tenantA)).rejects.toThrow(
      'outbox down',
    );
    expect(store.all(env.tenantA).filter((a) => a.incidentId === item.id)).toEqual([]);
    outbox.failing = false;
    await env.platform.incidentSlaModule.scanner.scan(env.tenantA);
    await env.platform.incidentSlaModule.scanner.scan(env.tenantA);
    const kinds = kindsOf(await alertsOf(env.manager(), `&incidentId=${item.id}`), item.id);
    expect(kinds).toContain('sla_warning');
    expect(await env.alertEvents(env.tenantA, item.id)).toBe(
      store.all(env.tenantA).filter((a) => a.incidentId === item.id).length,
    );
  });

  it('scans 500 open incidents in pages, well inside the 15 minute budget of SPECS 9.3 (acceptance 13)', async () => {
    const { env, world } = await fixture();
    await env.at(T0);
    const login = await world.platform.signIn(await world.principal('subject-manager-a'));
    const token = login.value?.token as string;
    const input = {
      vehicleId: env.vehicleA,
      type: 'other',
      severity: 'high',
      occurredAt: T0.toISOString(),
      location: { text: 'Calle Sintética' },
      description: 'Descripción sintética',
      vehicleOperable: true,
      noDriverReason: 'Vehículo estacionado',
      noPhotoJustification: 'Sin foto disponible',
    };
    for (let n = 0; n < 500; n += 1) {
      const created = await world.platform.incidents.create(token, `c-${n}`, input);
      expect(created.ok, JSON.stringify(created.error)).toBe(true);
      const done = await world.platform.incidentWorkflow.transition(
        token,
        `r-${n}`,
        created.value?.id as string,
        { command: 'report', version: created.value?.version },
      );
      expect(done.ok, JSON.stringify(done.error)).toBe(true);
    }
    await env.at(after(T0, 12 * DAY));
    const store = env.platform.incidentSlaModule.store;
    const cycles = vi.spyOn(store, 'cycles');
    const started = Date.now();
    const clock = performance.now();
    const summary = await env.platform.incidentSlaModule.scanner.scan(env.tenantA);
    const elapsed = performance.now() - clock;
    expect(started).toBeGreaterThan(0);
    expect(summary.examined).toBe(500);
    expect(summary.created).toBeGreaterThanOrEqual(500);
    // Never more than a page of cases is loaded at once.
    expect(cycles.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(Math.max(...cycles.mock.calls.map((call) => call[1].length))).toBeLessThanOrEqual(100);
    expect(elapsed).toBeLessThan(15 * 60_000);
    process.stdout.write(`sla-capacity: 500 cases scanned in ${Math.round(elapsed)} ms\n`);
    // A second scan finds everything already noticed.
    expect((await env.platform.incidentSlaModule.scanner.scan(env.tenantA)).created).toBe(0);
  }, 180_000);

  it('fails to start in production with the test sink, or with no mail adapter at all (acceptance 15)', () => {
    const verifier = new FakeOidcVerifier();
    const base = {
      verifier,
      issuer: verifier.issuer,
      grantSecret: 'synthetic-grant-secret-for-tests-0123456789',
    };
    expect(() => createPlatform({ ...base, environment: 'production' })).toThrow(/mail adapter/);
    expect(() =>
      createPlatform({
        ...base,
        environment: 'production',
        adapters: { incidentAlertMailer: new TestSinkMailer() },
      }),
    ).toThrow(/test sink/);
    const real = { send: async () => undefined };
    // A real mail adapter with the reserved addresses would drop every mail silently.
    expect(() =>
      createPlatform({
        ...base,
        environment: 'production',
        adapters: { incidentAlertMailer: real },
      }),
    ).toThrow(/address directory/);
    const platform: Platform = createPlatform({
      ...base,
      environment: 'production',
      adapters: {
        incidentAlertMailer: real,
        incidentAlertAddresses: { addressOf: async () => null },
      },
    });
    expect(platform.incidentSlaModule.mailer).toBe(real);
    expect(
      createPlatform({ ...base, environment: 'test' }).incidentSlaModule.mailer,
    ).toBeInstanceOf(TestSinkMailer);
    void P;
  });

  it('also fails closed for prod, and for NODE_ENV or OPSLOG_ENV announcing production', () => {
    const verifier = new FakeOidcVerifier();
    const base = {
      verifier,
      issuer: verifier.issuer,
      grantSecret: 'synthetic-grant-secret-for-tests-0123456789',
    };
    const real = { send: async () => undefined };
    // Built before the environment announces production: the default local KMS would refuse first.
    const pii = new EnvelopePiiCipher(LocalDevKms.ephemeral('test'));
    expect(() => createPlatform({ ...base, environment: 'prod' })).toThrow(/mail adapter/);
    expect(() =>
      createPlatform({ ...base, environment: 'Prod', adapters: { incidentAlertMailer: real } }),
    ).toThrow(/address directory/);
    for (const [name, value] of [
      ['NODE_ENV', 'production'],
      ['OPSLOG_ENV', 'prod'],
    ] as const) {
      vi.stubEnv(name, value);
      try {
        expect(() => createPlatform({ ...base, environment: 'test', adapters: { pii } })).toThrow(
          /mail adapter/,
        );
        expect(() =>
          createPlatform({
            ...base,
            environment: 'test',
            adapters: { pii, incidentAlertMailer: real },
          }),
        ).toThrow(/address directory/);
      } finally {
        vi.unstubAllEnvs();
      }
    }
  });
});
