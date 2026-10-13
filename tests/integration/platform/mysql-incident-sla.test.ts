import { afterAll, describe, expect, it, vi } from 'vitest';
import { INCIDENT_SLA_TABLES as T } from '../../../packages/persistence/incidents/sla/src/index.js';
import { adminUrl, startFleetDatabase, type FleetDatabase } from '../../e2e/fleet/mysql.js';
import { startFleetWorld, type FleetWorld } from '../../e2e/fleet/world.js';
import { defineSlaScenarios } from './incident-sla-scenarios.js';
import {
  Cases,
  DAY,
  FlakyMailer,
  T0,
  after,
  alertsOf,
  drainAll,
  type SlaEnv,
} from './incident-sla-support.js';

/**
 * The SLA on two real MySQL 8.4 databases (one per company, each with its own restricted runtime
 * accounts): notices and their outbox events in one transaction, deliveries claimed under a lease,
 * the worker draining the real outbox and the mail sink. Only synthetic data.
 */
const suite = adminUrl ? describe : describe.skip;

const opened: { database: FleetDatabase; fleet: FleetWorld }[] = [];
afterAll(async () => {
  for (const { database, fleet } of opened) {
    fleet.world.dispose();
    await database.close();
  }
}, 120_000);

async function start(): Promise<SlaEnv & { database: FleetDatabase; fleet: FleetWorld }> {
  const mailer = new FlakyMailer();
  const mailerB = new FlakyMailer();
  const database = await startFleetDatabase();
  const fleet = await startFleetWorld(database, {
    a: { incidentAlertMailer: mailer },
    b: { incidentAlertMailer: mailerB },
  });
  opened.push({ database, fleet });
  const db = database;
  const world = fleet;
  const manager = await world.worldA.member(
    'subject-admin-a',
    'incident_manager',
    'subject-manager-a',
  );
  const managerB = await world.worldB.member(
    'subject-admin-b',
    'incident_manager',
    'subject-manager-b',
  );
  const who = {
    admin: world.adminA,
    adminB: world.adminB,
    manager: await world.worldA.loginAs('subject-manager-a'),
    viewer: world.viewerA,
    managerB: await world.worldB.loginAs('subject-manager-b'),
  };
  const vehicleA = await world.vehicle(who.admin, await world.area(who.admin), 'SLA-A');
  const vehicleB = await world.vehicle(who.adminB, await world.area(who.adminB), 'SLA-B');
  let revoked = false;
  const rowsOf = (tenantId: string) => (tenantId === world.tenantA ? db.rows : db.rowsB).bind(db);
  return {
    database: db,
    fleet: world,
    platform: world.platformA,
    platformB: world.platformB,
    tenantA: world.tenantA,
    tenantB: world.tenantB,
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
      who.admin = await world.worldA.loginAs('subject-admin-a');
      who.adminB = await world.worldB.loginAs('subject-admin-b');
      if (!revoked) who.manager = await world.worldA.loginAs('subject-manager-a');
      who.viewer = await world.worldA.loginAs('subject-viewer-a');
      who.managerB = await world.worldB.loginAs('subject-manager-b');
    },
    revokeManager: async () => {
      const login = await world.platformA.signIn(await world.worldA.principal('subject-admin-a'));
      const removed = await world.platformA.removeMember(
        login.value?.token as string,
        'revoke-fixture',
        manager.identityId,
      );
      expect(removed.ok, JSON.stringify(removed.error)).toBe(true);
      revoked = true;
    },
    alertEvents: async (tenantId, incidentId) =>
      Number(
        (
          await rowsOf(tenantId)<{ n: number }>(
            `SELECT COUNT(*) AS n FROM opslog_tenant_outbox WHERE tenant_id=? AND type='incident.sla_alert' AND entity_id=?`,
            [tenantId, incidentId],
          )
        )[0]?.n,
      ),
    dump: async (tenantId) =>
      JSON.stringify([
        await rowsOf(tenantId)('SELECT * FROM opslog_tenant_outbox WHERE tenant_id=?', [tenantId]),
        await rowsOf(tenantId)(`SELECT * FROM ${T.alerts} WHERE company_id=?`, [tenantId]),
        await rowsOf(tenantId)(`SELECT * FROM ${T.deliveries} WHERE company_id=?`, [tenantId]),
      ]),
  };
}

suite('incident SLA on real MySQL', () => {
  const extra = (current: () => Awaited<ReturnType<typeof start>>) => {
    it('keeps one row per notice and per recipient and nothing of A in the database of B (acceptance 1, 10, 14)', async () => {
      const env = current();
      const { database: db } = env;
      const cases = new Cases(env.manager, env.admin, env.vehicleA, env.managerId, 'tables');
      await env.at(T0);
      const item = await cases.assigned('high');
      await env.at(after(T0, 12 * DAY));
      await Promise.all([
        env.platform.incidentSlaModule.scanner.scan(env.tenantA),
        env.platform.incidentSlaModule.scanner.scan(env.tenantA),
      ]);
      await drainAll(env.platform);
      await drainAll(env.platform);
      const alerts = await db.rows<{ id: string; kind: string }>(
        `SELECT id, kind FROM ${T.alerts} WHERE company_id=? AND incident_id=? ORDER BY kind`,
        [env.tenantA, item.id],
      );
      expect(new Set(alerts.map((a) => a.kind)).size).toBe(alerts.length);
      expect(alerts.map((a) => a.kind)).toContain('sla_warning');
      const warning = alerts.find((a) => a.kind === 'sla_warning') as { id: string };
      const rows = await db.rows<{ recipient_id: string; status: string; attempts: number }>(
        `SELECT recipient_id, status, attempts FROM ${T.deliveries} WHERE company_id=? AND alert_id=?`,
        [env.tenantA, warning.id],
      );
      expect(rows).toEqual([
        { recipient_id: `user-${env.managerId}`, status: 'sent', attempts: 1 },
      ]);
      expect(env.mailer.messages.filter((m) => m.alertId === warning.id)).toHaveLength(1);
      expect(await db.rowsB(`SELECT 1 FROM ${T.alerts} WHERE incident_id=?`, [item.id])).toEqual(
        [],
      );
      // The runtime account never rewrites or deletes a notice, and a mail failure left no trace of it.
      expect(JSON.stringify(rows)).not.toContain('@');
      expect(await alertsOf(env.manager(), `&incidentId=${item.id}`)).not.toEqual([]);
    });
  };
  defineSlaScenarios('MySQL composition', start, extra);
});

suite('incident SLA capacity on real MySQL', () => {
  it('scans 500 open incidents in pages inside the SPECS 9.3 budget (acceptance 13)', async () => {
    const env = await start();
    await env.at(T0);
    const world = env.fleet.worldA;
    const login = await world.platform.signIn(await world.principal('subject-admin-a'));
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
    const clock = performance.now();
    const summary = await env.platform.incidentSlaModule.scanner.scan(env.tenantA);
    const elapsed = performance.now() - clock;
    expect(summary.examined).toBe(500);
    expect(Math.max(...cycles.mock.calls.map((call) => call[1].length))).toBeLessThanOrEqual(100);
    expect(elapsed).toBeLessThan(15 * 60_000);
    process.stdout.write(
      `sla-capacity-mysql: ${summary.examined} cases scanned in ${Math.round(elapsed)} ms\n`,
    );
    expect((await env.platform.incidentSlaModule.scanner.scan(env.tenantA)).created).toBe(0);
  }, 600_000);
});
