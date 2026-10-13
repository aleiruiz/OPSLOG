import mysql from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WORK_ORDER_TABLES } from '../../../packages/persistence/maintenance/orders/src/index.js';
import { INCIDENT_COST_TABLES as C } from '../../../packages/persistence/incidents/costs/src/index.js';
import { INCIDENT_REPAIR_TABLES as R } from '../../../packages/persistence/incidents/repairs/src/index.js';
import { adminUrl, startFleetDatabase, type FleetDatabase } from './mysql.js';
import { startFleetWorld, type FleetWorld } from './world.js';

const suite = adminUrl ? describe : describe.skip;
const P = '/api/v1/incidents';
const W = '/api/v1/work-orders';
const NOTE = 'Nota libre sintética de un costo';

suite('incident costs and repair links on real MySQL with two synthetic tenants', () => {
  let database: FleetDatabase;
  let fleet: FleetWorld;
  let managerA: Awaited<ReturnType<FleetWorld['worldA']['loginAs']>>;
  let managerB: typeof managerA;
  let managerAId: string;
  let managerBId: string;
  let vehicleA: string;
  let vehicleB: string;
  let n = 0;
  const key = () => `key-costs-e2e-${(n += 1)}-${Date.now()}`;
  const withKey = (json: Record<string, unknown>) => ({
    json,
    headers: { 'idempotency-key': key() },
  });

  beforeAll(async () => {
    database = await startFleetDatabase();
    fleet = await startFleetWorld(database);
    managerAId = (
      await fleet.worldA.member('subject-admin-a', 'incident_manager', 'subject-manager-a')
    ).identityId;
    managerA = await fleet.worldA.loginAs('subject-manager-a');
    managerBId = (
      await fleet.worldB.member('subject-admin-b', 'incident_manager', 'subject-manager-b')
    ).identityId;
    managerB = await fleet.worldB.loginAs('subject-manager-b');
    vehicleA = await fleet.vehicle(fleet.adminA, await fleet.area(fleet.adminA), 'CO-A');
    vehicleB = await fleet.vehicle(fleet.adminB, await fleet.area(fleet.adminB), 'CO-B');
  }, 120_000);
  afterAll(async () => {
    fleet?.world.dispose();
    await database?.close();
  }, 60_000);

  const go = (browser: typeof managerA, id: string, json: Record<string, unknown>) =>
    browser.post(`${P}/${id}/transitions`, withKey(json));
  async function underReview(
    browser = managerA,
    vehicleId = vehicleA,
    responsibleId = managerAId,
    over: Record<string, unknown> = {},
  ) {
    const created = await browser.post(P, {
      json: {
        vehicleId,
        type: 'other',
        severity: 'low',
        occurredAt: new Date().toISOString(),
        location: { text: 'Calle Sintética' },
        description: 'Descripción sintética',
        vehicleOperable: true,
        noDriverReason: 'Vehículo estacionado',
        noPhotoJustification: 'Sin foto disponible',
        ...over,
      },
    });
    expect(created.status, created.text).toBe(201);
    const id = created.json.id as string;
    const reported = await go(browser, id, { command: 'report', version: 1 });
    const assigned = await go(browser, id, {
      command: 'assign',
      version: reported.json.version,
      responsibleId,
    });
    const reviewed = await go(browser, id, { command: 'review', version: assigned.json.version });
    expect(reviewed.status, reviewed.text).toBe(200);
    return { id, version: reviewed.json.version as number };
  }
  const order = async (browser: typeof fleet.adminA, vehicleId: string) => {
    const created = await browser.post(W, { json: { vehicleId, description: 'Frenos rechinan' } });
    expect(created.status, created.text).toBe(201);
    return created.json.id as string;
  };
  const line = (kind: string, category: string, amountMinor: string, currency = 'MXN') => ({
    kind,
    category,
    amount: { amountMinor, currency },
  });

  it('keeps exact amounts per currency, nothing of them in audit or outbox, and shows them only with view_costs (cases 3, 4, 10)', async () => {
    const { id, version } = await underReview();
    const saved = await managerA.put(
      `${P}/${id}/costs`,
      withKey({
        version,
        lines: [
          { ...line('expense', 'deductible', '1000000'), note: NOTE },
          line('expense', 'towing', '200000'),
          line('recovery', 'insurer', '800000'),
          line('expense', 'fine', '12345', 'USD'),
        ],
        initialEstimate: { amountMinor: '777777', currency: 'MXN' },
      }),
    );
    expect(saved.status, saved.text).toBe(200);
    expect(saved.json.totals).toEqual([
      {
        currency: 'MXN',
        repairs: '0',
        expenses: '1200000',
        recoveries: '800000',
        companyBorne: '400000',
      },
      { currency: 'USD', repairs: '0', expenses: '12345', recoveries: '0', companyBorne: '12345' },
    ]);
    expect(saved.json.mixedCurrencies).toBe(true);
    const rows = await database.rows<{ amount_minor: string; currency: string }>(
      'SELECT amount_minor, currency FROM opslog_incident_cost_lines WHERE incident_id = ? ORDER BY position',
      [id],
    );
    expect(rows.map((r) => `${r.amount_minor}${r.currency}`)).toEqual([
      '1000000MXN',
      '200000MXN',
      '800000MXN',
      '12345USD',
    ]);
    for (const table of [
      'opslog_audit_local',
      'opslog_tenant_outbox',
      'opslog_incident_transitions',
    ]) {
      const dump = JSON.stringify(await database.rows(`SELECT * FROM ${table}`));
      for (const secret of [NOTE, '1000000', '777777', '12345'])
        expect(dump, table).not.toContain(secret);
    }
    const events = await database.rows<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM opslog_tenant_outbox WHERE entity_id = ? AND type = 'incident.costs_changed'",
      [id],
    );
    expect(events.map((e) => Object.keys(e.payload).sort().join())).toEqual(['incidentId,version']);
    // The case itself, the timeline and the generic roles show no amount.
    expect((await managerA.get(`${P}/${id}`)).text).not.toMatch(/1000000|MXN/);
    expect((await managerA.get(`${P}/${id}/timeline`)).text).not.toMatch(/1000000|MXN|USD/);
    const asEditor = await fleet.editorA.get(`${P}/${id}/costs`);
    expect([403, 404]).toContain(asEditor.status);
    expect(asEditor.text).not.toMatch(/1000000|MXN/);
  });

  it('links a real order once, reads it live, and the other tenant sees nothing (cases 1, 2, 9)', async () => {
    const { id, version } = await underReview();
    const orderId = await order(fleet.adminA, vehicleA);
    const linkKey = key();
    const linked = await managerA.post(`${P}/${id}/repairs`, {
      json: { version, orderId },
      headers: { 'idempotency-key': linkKey },
    });
    expect(linked.status, linked.text).toBe(200);
    // A retry after a lost answer (same key, same body) repeats it: one link, one version.
    const replayed = await managerA.post(`${P}/${id}/repairs`, {
      json: { version, orderId },
      headers: { 'idempotency-key': linkKey },
    });
    expect([replayed.status, replayed.json]).toEqual([200, linked.json]);
    expect(linked.json.item.order).toMatchObject({ id: orderId, description: 'Frenos rechinan' });
    const other = await underReview();
    const twice = await managerA.post(
      `${P}/${other.id}/repairs`,
      withKey({ version: other.version, orderId }),
    );
    expect([twice.status, twice.json.code]).toEqual([409, 'duplicate']);
    expect(
      await database.rows('SELECT 1 FROM opslog_incident_repair_links WHERE order_id = ?', [
        orderId,
      ]),
    ).toHaveLength(1);
    const costs = await managerA.get(`${P}/${id}/costs`);
    expect(costs.json.repairs).toEqual([expect.objectContaining({ orderId, totals: [] })]);
    // Tenant B cannot read A's case, A's link, or link A's order into its own case.
    expect((await managerB.get(`${P}/${id}/costs`)).status).toBe(404);
    expect((await managerB.get(`${P}/${id}/repairs`)).status).toBe(404);
    const mine = await underReview(managerB, vehicleB, managerBId);
    const foreign = await managerB.post(
      `${P}/${mine.id}/repairs`,
      withKey({ version: mine.version, orderId }),
    );
    expect(foreign.status).toBe(404);
    expect(await database.rowsB('SELECT 1 FROM opslog_incident_repair_links')).toEqual([]);
    expect(await database.rowsB('SELECT 1 FROM opslog_incident_cost_lines')).toEqual([]);
    const gone = await managerA.post(
      `${P}/${id}/repairs/${linked.json.item.id}/unlink`,
      withKey({ version: linked.json.version }),
    );
    expect(gone.status, gone.text).toBe(200);
    expect(
      await database.rows('SELECT 1 FROM opslog_incident_repair_links WHERE order_id = ?', [
        orderId,
      ]),
    ).toEqual([]);
  });

  it('reads the cost of a real order from MySQL beside the own lines and applies the D20 threshold exactly (cases 3, 14)', async () => {
    const mechanicMember = await fleet.worldA.member(
      'subject-admin-a',
      'viewer',
      'subject-mech-co',
    );
    const mechA = await fleet.worldA.loginAs('subject-mech-co');
    const workshop = await fleet.adminA.post('/api/v1/maintenance/workshops', {
      json: { name: 'Taller Costos', specialties: ['frenos'] },
    });
    const mechanic = await fleet.adminA.post('/api/v1/maintenance/mechanics', {
      json: {
        name: 'Mecánico Costos',
        specialties: ['frenos'],
        kind: 'internal',
        workshopId: workshop.json.id,
        memberId: mechanicMember.identityId,
      },
    });
    expect(mechanic.status, mechanic.text).toBe(201);
    const orderId = await order(fleet.adminA, vehicleA);
    const t = (browser: typeof fleet.adminA, json: Record<string, unknown>) =>
      browser.post(`${W}/${orderId}/transitions`, { json });
    const assigned = await t(fleet.adminA, {
      command: 'assign',
      version: 1,
      responsibleId: managerAId,
      workshopId: workshop.json.id,
      mechanicId: mechanic.json.id,
      scheduledDate: '2026-10-13',
    });
    expect(assigned.status, assigned.text).toBe(200);
    const started = await t(mechA, { command: 'start', version: assigned.json.version });
    const worked = await mechA.put(`${W}/${orderId}/work`, {
      json: {
        version: started.json.version,
        tasks: [{ description: 'Cambio de balatas' }],
        parts: [{ name: 'Balata', quantity: '4' }],
      },
    });
    const costed = await fleet.adminA.put(`${W}/${orderId}/costs`, {
      json: {
        version: worked.json.version,
        costs: [{ category: 'labor', amount: { amountMinor: '400000', currency: 'MXN' } }],
      },
    });
    expect(costed.status, costed.text).toBe(200);
    const threshold = await fleet.adminA.put('/api/alerts/settings', {
      json: {
        version: 0,
        expiryWindowDays: 7,
        recipientRoles: ['admin'],
        closeCostThreshold: { amountMinor: '500000', currency: 'MXN' },
      },
    });
    expect(threshold.status, threshold.text).toBe(200);
    try {
      const incident = await underReview();
      const linked = await managerA.post(
        `${P}/${incident.id}/repairs`,
        withKey({ version: incident.version, orderId }),
      );
      expect(linked.status, linked.text).toBe(200);
      const exact = await managerA.put(
        `${P}/${incident.id}/costs`,
        withKey({ version: linked.json.version, lines: [line('expense', 'towing', '100000')] }),
      );
      expect(exact.json.totals).toEqual([
        {
          currency: 'MXN',
          repairs: '400000',
          expenses: '100000',
          recoveries: '0',
          companyBorne: '500000',
        },
      ]);
      // The totals are exact at the threshold boundary: 5.000,00 and one minor unit more.
      const over = await managerA.put(
        `${P}/${incident.id}/costs`,
        withKey({
          version: exact.json.version,
          lines: [line('expense', 'towing', '100000'), line('expense', 'other', '1')],
        }),
      );
      expect(over.json.totals[0].companyBorne).toBe('500001');
      // The order's amounts are read live: nothing of them was copied into the case's tables.
      expect(
        JSON.stringify(
          await database.rows(`SELECT * FROM ${C.lines} WHERE incident_id = ?`, [incident.id]),
        ),
      ).not.toContain('400000');
    } finally {
      const current = await fleet.adminA.get('/api/alerts/settings');
      await fleet.adminA.put('/api/alerts/settings', {
        json: {
          version: current.json.version,
          expiryWindowDays: 7,
          recipientRoles: ['admin'],
          closeCostThreshold: null,
        },
      });
    }
  });

  it('closes with the snapshot of the cycle, and a change after the closure is reported against it (cases 5, 6)', async () => {
    const { id, version } = await underReview();
    const priced = await managerA.put(
      `${P}/${id}/costs`,
      withKey({ version, lines: [line('expense', 'towing', '100')] }),
    );
    const resolutionSaved = await managerA.put(`${P}/${id}/resolution`, {
      json: {
        version: priced.json.version,
        resolutionSummary: 'Resuelto de forma sintética',
        vehicleStatusDecision: 'restricted',
      },
    });
    const resolvedNow = await go(managerA, id, {
      command: 'resolve',
      version: resolutionSaved.json.version,
    });
    expect(resolvedNow.status, resolvedNow.text).toBe(200);
    const closed = await go(managerA, id, { command: 'close', version: resolvedNow.json.version });
    expect(closed.status, closed.text).toBe(200);
    const snapshots = await database.rows<{ cycle: number; totals: unknown }>(
      'SELECT cycle, totals FROM opslog_incident_cost_snapshots WHERE incident_id = ?',
      [id],
    );
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.cycle).toBe(1);
    const view = await managerA.get(`${P}/${id}/costs`);
    expect(view.json.snapshots).toEqual([
      expect.objectContaining({
        cycle: 1,
        totals: [expect.objectContaining({ companyBorne: '100' })],
      }),
    ]);
    expect(view.json.differsFromLastClosure).toBe(false);
    // Closed is immutable for costs too.
    const late = await managerA.put(
      `${P}/${id}/costs`,
      withKey({ version: closed.json.version, lines: [] }),
    );
    expect(late.status).toBe(409);
  });

  it('the incidents runtime account reads and writes only its own tables, and rewrites nothing the closure kept (grants, case 12)', async () => {
    const account = database.accounts.incidents;
    const connection = await mysql.createConnection({
      host: database.host,
      port: database.port,
      user: account.username,
      password: account.password,
      database: database.databaseName,
    });
    try {
      for (const table of [C.lines, C.estimates, C.snapshots, R.links])
        await expect(connection.query(`SELECT 1 FROM \`${table}\` LIMIT 0`)).resolves.toBeDefined();
      for (const sql of [
        `SELECT 1 FROM \`${WORK_ORDER_TABLES.orders}\` LIMIT 0`,
        `UPDATE \`${C.snapshots}\` SET cycle = 9`,
        `DELETE FROM \`${C.snapshots}\``,
        `UPDATE \`${C.lines}\` SET currency = 'USD'`,
        `UPDATE \`${R.links}\` SET order_id = 'x'`,
        `DROP TABLE \`${R.links}\``,
      ])
        await expect(connection.query(sql), sql).rejects.toThrow(/denied|privilege/i);
    } finally {
      await connection.end();
    }
  });
});
