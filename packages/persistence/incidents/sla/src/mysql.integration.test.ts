import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { AUDIT_TABLES } from '../../../audit/src/index.js';
import {
  IncidentAlertDelivery,
  IncidentSlaScanner,
  type NewAlert,
} from '../../../../domain/incidents/sla/src/index.js';
import {
  FakeAddresses,
  FakeMembers,
  FakeSettings,
  RecordingMailer,
} from '../../../../domain/incidents/sla/src/test-support.js';
import {
  adminUrl,
  startIncidentDatabase,
  type IncidentTestDatabase,
} from '../../cases/src/test-support/mysql.js';
import {
  createIncidentRepairsMigrationDataSource,
  runIncidentRepairsMigrations,
} from '../../repairs/src/data-source.js';
import { INCIDENT_REPAIR_TABLES as R } from '../../repairs/src/entities.js';
import {
  createIncidentCostsMigrationDataSource,
  runIncidentCostsMigrations,
} from '../../costs/src/data-source.js';
import { INCIDENT_COST_TABLES as C } from '../../costs/src/entities.js';
import {
  createIncidentWorkflowMigrationDataSource,
  runIncidentWorkflowMigrations,
} from '../../workflow/src/data-source.js';
import { INCIDENT_WORKFLOW_TABLES as W } from '../../workflow/src/entities.js';
import { DRAFT, MANAGER, NOW, Shared, incidentWorld } from '../../costs/src/test-support/world.js';
import { createIncidentSlaMigrationDataSource, runIncidentSlaMigrations } from './data-source.js';
import { INCIDENT_SLA_TABLES as T } from './entities.js';
import { TypeOrmIncidentSlaStore } from './store.js';

const suite = adminUrl ? describe : describe.skip;
const DAY = 86_400_000;

suite('incident SLA on disposable MySQL 8.4', () => {
  let db: IncidentTestDatabase;
  let sourceA: DataSource;
  let sourceA2: DataSource;
  let sourceB: DataSource;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const shared = new Shared();
  const migrate = async (owner: Parameters<typeof createIncidentRepairsMigrationDataSource>[0]) => {
    for (const [create, run] of [
      [createIncidentWorkflowMigrationDataSource, runIncidentWorkflowMigrations],
      [createIncidentRepairsMigrationDataSource, runIncidentRepairsMigrations],
      [createIncidentCostsMigrationDataSource, runIncidentCostsMigrations],
      [createIncidentSlaMigrationDataSource, runIncidentSlaMigrations],
    ] as const) {
      const source = create(owner);
      await source.initialize();
      try {
        await run(source);
      } finally {
        await source.destroy();
      }
    }
  };
  /** A reported case with a responsible, as a user would leave it. */
  async function reported(source: DataSource, tenant: string, severity = 'critical') {
    const w = incidentWorld(source, shared);
    const created = await w.incidents.create(tenant, MANAGER, { ...DRAFT, severity });
    const run = (current: { id: string; version: number }, command: string, extra = {}) =>
      w.workflow.execute(tenant, MANAGER, current.id, {
        command,
        version: current.version,
        ...extra,
      });
    const done = await run(created, 'report');
    return run(done, 'assign', { responsibleId: MANAGER.subject });
  }
  const alertFor = (
    tenant: string,
    incident: { id: string; folio: string },
    over: Partial<NewAlert> = {},
  ): NewAlert => ({
    tenantId: tenant,
    incidentId: incident.id,
    folio: incident.folio,
    cycle: 1,
    kind: 'sla_warning',
    dedupeRef: '1',
    severity: 'critical',
    deadline: new Date(NOW.getTime() + 7 * DAY).toISOString(),
    subjectId: null,
    createdAt: NOW.toISOString(),
    ...over,
  });
  const outboxOf = (tenant: string, entityId: string) =>
    db.rows<{ type: string; payload: Record<string, unknown>; actor_ref: unknown }>(
      `SELECT * FROM ${AUDIT_TABLES.outbox} WHERE tenant_id=? AND entity_id=? AND type='incident.sla_alert'`,
      [tenant, entityId],
    );

  beforeAll(async () => {
    db = await startIncidentDatabase('sla', {
      migrate,
      grants: [
        { table: W.closures, privileges: 'SELECT, INSERT' },
        { table: R.links, privileges: 'SELECT, INSERT, DELETE' },
        { table: C.lines, privileges: 'SELECT, INSERT, DELETE' },
        { table: C.estimates, privileges: 'SELECT, INSERT, UPDATE, DELETE' },
        { table: C.snapshots, privileges: 'SELECT, INSERT' },
        { table: T.cycles, privileges: 'SELECT, INSERT, UPDATE' },
        { table: T.alerts, privileges: 'SELECT, INSERT' },
        { table: T.deliveries, privileges: 'SELECT, INSERT, UPDATE' },
      ],
    });
    sourceA = await db.openIncidents('a');
    sourceA2 = await db.openIncidents('a');
    sourceB = await db.openIncidents('b');
  }, 180_000);
  afterAll(async () => {
    await db?.close();
  }, 60_000);

  it('writes the notice and its event together, once, with a system actor and an id-only payload', async () => {
    const incident = await reported(sourceA, tenantA);
    const store = new TypeOrmIncidentSlaStore(sourceA);
    const first = await store.createAlert(alertFor(tenantA, incident));
    expect(first).toMatchObject({ kind: 'sla_warning', folio: incident.folio });
    // A second writer (another connection) sees the unique key and writes nothing.
    expect(
      await new TypeOrmIncidentSlaStore(sourceA2).createAlert(alertFor(tenantA, incident)),
    ).toBe(null);
    const events = await outboxOf(tenantA, incident.id);
    expect(events).toHaveLength(1);
    expect(Object.keys(events[0]?.payload ?? {}).sort()).toEqual([
      'alertId',
      'cycle',
      'incidentId',
      'kind',
    ]);
    expect(JSON.stringify(events[0])).toContain('system:incident-sla');
    expect(await store.alert(tenantA, (first as { id: string }).id)).toEqual(first);
    // Tenant B's database holds nothing, and a foreign tenant id finds nothing.
    expect(await db.rowsB(`SELECT 1 FROM ${T.alerts}`)).toEqual([]);
    expect(await store.alert(tenantB, (first as { id: string }).id)).toBeNull();
  });

  it('keeps no notice when the outbox fails (atomicity)', async () => {
    const incident = await reported(sourceA, tenantA);
    const failing = new TypeOrmIncidentSlaStore(sourceA, {
      transaction: async () => {
        throw new Error('outbox down');
      },
    });
    await expect(failing.createAlert(alertFor(tenantA, incident))).rejects.toThrow('outbox down');
    expect(
      await db.rows(`SELECT 1 FROM ${T.alerts} WHERE company_id=? AND incident_id=?`, [
        tenantA,
        incident.id,
      ]),
    ).toEqual([]);
    expect(await outboxOf(tenantA, incident.id)).toEqual([]);
  });

  it('queues a scan job in the tenant outbox once, for a case or for all, with a system actor and no tenant in the payload', async () => {
    const incident = await reported(sourceA, tenantA);
    const store = new TypeOrmIncidentSlaStore(sourceA);
    const at = NOW.toISOString();
    await store.enqueueScan({ tenantId: tenantA, jobId: 'job-all', at });
    await store.enqueueScan({ tenantId: tenantA, jobId: 'job-all', at });
    await store.enqueueScan({ tenantId: tenantA, jobId: 'job-one', incidentId: incident.id, at });
    const jobs = await db.rows<{ event_id: string; payload: Record<string, unknown> }>(
      `SELECT event_id, payload FROM ${AUDIT_TABLES.outbox} WHERE tenant_id=? AND type='incident.sla.scan' ORDER BY event_id`,
      [tenantA],
    );
    expect(jobs.map((j) => [j.event_id, j.payload])).toEqual([
      ['scan-job-all', {}],
      ['scan-job-one', { incidentId: incident.id }],
    ]);
    for (const job of [{ jobId: '' }, { jobId: 'a b' }, { jobId: 'ok', incidentId: '../x' }])
      await expect(store.enqueueScan({ tenantId: tenantA, at, ...job })).rejects.toThrow(
        'invalid incident SLA scan job',
      );
  });

  it('opens a cycle once and retargets by compare-and-set', async () => {
    const incident = await reported(sourceA, tenantA);
    const store = new TypeOrmIncidentSlaStore(sourceA);
    const row = {
      tenantId: tenantA,
      incidentId: incident.id,
      cycle: 1,
      startedAt: NOW.toISOString(),
      severity: 'critical' as const,
      targetDays: 7,
      targetVersion: 1,
    };
    await store.openCycle(row);
    await new TypeOrmIncidentSlaStore(sourceA2).openCycle({ ...row, targetDays: 99 });
    expect(await store.cycles(tenantA, [incident.id])).toEqual([row]);
    const moved = { ...row, severity: 'low' as const, targetDays: 45, targetVersion: 2 };
    expect(await store.retarget(moved, 1)).toBe(true);
    expect(
      await new TypeOrmIncidentSlaStore(sourceA2).retarget({ ...moved, targetVersion: 3 }, 1),
    ).toBe(false);
    expect(await store.cycles(tenantA, [incident.id])).toEqual([moved]);
    expect(await store.cycles(tenantB, [incident.id])).toEqual([]);
    expect(await store.cycles(tenantA, [])).toEqual([]);
  });

  it('lists only what the viewer may see, filtered and paged, newest first', async () => {
    const mine = await reported(sourceA, tenantA);
    const store = new TypeOrmIncidentSlaStore(sourceA);
    const at = (n: number) => new Date(NOW.getTime() + n * 1000).toISOString();
    await store.createAlert(alertFor(tenantA, mine, { kind: 'sla_breach', createdAt: at(3) }));
    await store.createAlert(
      alertFor(tenantA, mine, { kind: 'unassigned', dedupeRef: 'x', createdAt: at(2) }),
    );
    await store.createAlert(
      alertFor(tenantA, mine, {
        kind: 'assigned',
        dedupeRef: 'v2',
        subjectId: MANAGER.id,
        createdAt: at(1),
      }),
    );
    const view = { id: MANAGER.id, edit: false, approve: false };
    const all = (v: typeof view, filter = {}, limit: 25 | 50 | 100 = 25, offset = 0) =>
      store.listAlerts(tenantA, v, { ...filter, incidentId: mine.id }, { limit, offset });
    // The responsible sees the breach and the notice of their own assignment, not the unassigned one.
    expect((await all(view)).rows.map((a) => a.kind)).toEqual(['sla_breach', 'assigned']);
    // Someone who edits sees unassigned; the breach needs approving rights.
    const editor = { id: 'user-other', edit: true, approve: false };
    expect((await all(editor)).rows.map((a) => a.kind)).toEqual(['unassigned']);
    expect((await all({ ...editor, approve: true })).rows.map((a) => a.kind)).toEqual([
      'sla_breach',
      'unassigned',
    ]);
    expect((await all({ ...editor, approve: true }, { kind: 'sla_breach' })).total).toBe(1);
    expect((await all({ id: 'user-nobody', edit: false, approve: false })).total).toBe(0);
    const paged = await all({ ...editor, approve: true }, {}, 25, 1);
    expect(paged.rows.map((a) => a.kind)).toEqual(['unassigned']);
    expect(paged.total).toBe(2);
    // Another tenant sees nothing of it.
    expect(
      (await store.listAlerts(tenantB, editor, { incidentId: mine.id }, { limit: 25, offset: 0 }))
        .total,
    ).toBe(0);
  });

  it('claims a delivery for one worker at a time, with a lease, and keeps final rows final', async () => {
    const incident = await reported(sourceA, tenantA);
    const store = new TypeOrmIncidentSlaStore(sourceA);
    const alert = (await store.createAlert(
      alertFor(tenantA, incident, { dedupeRef: 'claim' }),
    )) as {
      id: string;
    };
    const key = {
      tenantId: tenantA,
      alertId: alert.id,
      recipientId: MANAGER.id,
      channel: 'email' as const,
    };
    const t0 = NOW.toISOString();
    const stores = [store, new TypeOrmIncidentSlaStore(sourceA2)];
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, n) => stores[n % 2]?.claimDelivery(key, t0, 60_000)),
    );
    expect(results.filter((r) => r?.result === 'claimed')).toHaveLength(1);
    expect(results.filter((r) => r?.result === 'busy')).toHaveLength(7);
    // After the lease a new worker takes the row; the old attempt can no longer settle it.
    const later = new Date(NOW.getTime() + 61_000).toISOString();
    expect(await store.claimDelivery(key, later, 60_000)).toEqual({
      result: 'claimed',
      attempt: 2,
    });
    await store.settleDelivery(key, 1, { status: 'sent' });
    expect((await store.deliveries(tenantA, alert.id))[0]).toMatchObject({
      status: 'pending',
      attempts: 2,
    });
    await store.settleDelivery(key, 2, { status: 'retry', nextAttemptAt: later });
    expect((await store.deliveries(tenantA, alert.id))[0]).toMatchObject({
      status: 'pending',
      nextAttemptAt: later,
    });
    const third = await store.claimDelivery(key, later, 60_000);
    expect(third).toEqual({ result: 'claimed', attempt: 3 });
    await store.settleDelivery(key, 3, { status: 'sent' });
    expect(await store.claimDelivery(key, later, 60_000)).toEqual({ result: 'done' });
    // A sent row is not skipped afterwards; a new recipient is skipped with no attempt.
    await store.skipDelivery(key);
    const other = { ...key, recipientId: 'user-other' };
    await store.skipDelivery(other);
    await store.skipDelivery(other);
    const rows = await store.deliveries(tenantA, alert.id);
    expect(rows.map((r) => [r.recipientId, r.status])).toEqual([
      [MANAGER.id, 'sent'],
      ['user-other', 'skipped'],
    ]);
    // A pending row that gets skipped is final, and a failed one stays failed.
    const pending = { ...key, recipientId: 'user-pending' };
    await store.claimDelivery(pending, t0, 1);
    await store.skipDelivery(pending);
    expect(await store.claimDelivery(pending, later, 1)).toEqual({ result: 'done' });
    const failed = { ...key, recipientId: 'user-failed' };
    await store.claimDelivery(failed, t0, 1);
    await store.settleDelivery(failed, 1, { status: 'failed' });
    await store.skipDelivery(failed);
    expect(
      (await store.deliveries(tenantA, alert.id)).find((r) => r.recipientId === 'user-failed')
        ?.status,
    ).toBe('failed');
  });

  it('the runtime account cannot change or delete a notice, and a delivery keeps no address', async () => {
    const incident = await reported(sourceA, tenantA);
    const store = new TypeOrmIncidentSlaStore(sourceA);
    const alert = (await store.createAlert(alertFor(tenantA, incident, { dedupeRef: 'ro' }))) as {
      id: string;
    };
    await expect(
      sourceA.query(`UPDATE ${T.alerts} SET folio='X' WHERE id=?`, [alert.id]),
    ).rejects.toThrow();
    await expect(sourceA.query(`DELETE FROM ${T.alerts} WHERE id=?`, [alert.id])).rejects.toThrow();
    await expect(sourceA.query(`DELETE FROM ${T.deliveries}`)).rejects.toThrow();
    const columns = await db.rows<{ COLUMN_NAME: string }>(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=?`,
      [db.databaseName, T.deliveries],
    );
    expect(columns.map((c) => c.COLUMN_NAME).sort()).toEqual([
      'alert_id',
      'attempts',
      'channel',
      'company_id',
      'lease_until',
      'next_attempt_at',
      'recipient_id',
      'status',
    ]);
  });

  it('scans and delivers on real tables: one message per recipient across repeated scans and two workers', async () => {
    const incident = await reported(sourceA, tenantA);
    const clock = { now: new Date(NOW.getTime() + 6 * DAY) };
    const now = () => clock.now;
    const settings = new FakeSettings();
    const members = new FakeMembers();
    members.set(tenantA, MANAGER.id, ['incidents:view', 'incidents:edit', 'incidents:approve']);
    const mailer = new RecordingMailer();
    const world = incidentWorld(sourceA, shared);
    const makeStore = (source: DataSource) => new TypeOrmIncidentSlaStore(source);
    const scan = (source: DataSource) =>
      new IncidentSlaScanner(world.store, makeStore(source), settings, { now }).scan(
        tenantA,
        incident.id,
      );
    await Promise.all([scan(sourceA), scan(sourceA2), scan(sourceA), scan(sourceA2)]);
    for (let n = 0; n < 6; n += 1) await scan(sourceA);
    const alerts = await db.rows<{ id: string; kind: string }>(
      `SELECT id, kind FROM ${T.alerts} WHERE company_id=? AND incident_id=? ORDER BY kind`,
      [tenantA, incident.id],
    );
    const kinds = alerts.map((a) => a.kind);
    expect(kinds).toContain('sla_warning');
    expect(new Set(kinds).size).toBe(kinds.length);
    const warning = alerts.find((a) => a.kind === 'sla_warning') as { id: string };
    const deliver = (source: DataSource) =>
      new IncidentAlertDelivery(
        world.store,
        makeStore(source),
        members,
        new FakeAddresses(),
        mailer,
        { now },
      ).deliver(tenantA, {
        incidentId: incident.id,
        alertId: warning.id,
        kind: 'sla_warning',
        cycle: 1,
      });
    await Promise.all([deliver(sourceA), deliver(sourceA2)]).catch(() => undefined);
    await deliver(sourceA);
    await deliver(sourceA2);
    expect(mailer.sent.filter((m) => m.alertId === warning.id)).toHaveLength(1);
    const body = JSON.stringify(mailer.sent);
    expect(body).toContain(incident.folio);
    const rows = await makeStore(sourceA).deliveries(tenantA, warning.id);
    expect(rows).toEqual([expect.objectContaining({ recipientId: MANAGER.id, status: 'sent' })]);
    expect(JSON.stringify(await db.rows(`SELECT * FROM ${T.deliveries}`))).not.toContain('@');
    void sourceB;
  });
});
