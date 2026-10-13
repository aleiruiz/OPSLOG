import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminUrl, startFleetDatabase, type FleetDatabase } from './mysql.js';
import { startFleetWorld, type FleetWorld } from './world.js';

const suite = adminUrl ? describe : describe.skip;
const P = '/api/v1/incidents';
const FREE_TEXT = 'Texto libre sintético del cierre';
const REASON = 'Motivo libre sintético de la reapertura';

suite('incident approvals, close and reopen on real MySQL with two synthetic tenants', () => {
  let database: FleetDatabase;
  let fleet: FleetWorld;
  let managerA: Awaited<ReturnType<FleetWorld['worldA']['loginAs']>>;
  let managerAId: string;
  let managerB: typeof managerA;
  let vehicleA: string;
  let vehicleB: string;
  let n = 0;
  const key = () => `key-close-e2e-${(n += 1)}-${Date.now()}`;

  beforeAll(async () => {
    database = await startFleetDatabase();
    fleet = await startFleetWorld(database);
    managerAId = (
      await fleet.worldA.member('subject-admin-a', 'incident_manager', 'subject-manager-a')
    ).identityId;
    managerA = await fleet.worldA.loginAs('subject-manager-a');
    await fleet.worldB.member('subject-admin-b', 'incident_manager', 'subject-manager-b');
    managerB = await fleet.worldB.loginAs('subject-manager-b');
    vehicleA = await fleet.vehicle(fleet.adminA, await fleet.area(fleet.adminA), 'CL-A');
    vehicleB = await fleet.vehicle(fleet.adminB, await fleet.area(fleet.adminB), 'CL-B');
  }, 120_000);
  afterAll(async () => {
    fleet?.world.dispose();
    await database?.close();
  }, 60_000);

  const transition = (
    browser: typeof managerA,
    id: string,
    json: Record<string, unknown>,
    k?: string,
  ) =>
    browser.post(`${P}/${id}/transitions`, {
      json,
      ...(k ? { headers: { 'idempotency-key': k } } : {}),
    });

  /** A direct-route case of tenant A taken to `resolved` by the manager. */
  async function resolved(vehicleId = vehicleA, over: Record<string, unknown> = {}) {
    const created = await managerA.post(P, {
      json: {
        vehicleId,
        type: 'other',
        severity: 'low',
        occurredAt: new Date().toISOString(),
        location: { text: 'Calle Sintética' },
        description: FREE_TEXT,
        vehicleOperable: true,
        noDriverReason: 'Vehículo estacionado',
        noPhotoJustification: 'Sin foto disponible',
        ...over,
      },
    });
    expect(created.status, created.text).toBe(201);
    const id = created.json.id as string;
    const reported = await transition(managerA, id, { command: 'report', version: 1 });
    const assigned = await transition(managerA, id, {
      command: 'assign',
      version: reported.json.version,
      responsibleId: managerAId,
    });
    const review = await transition(managerA, id, {
      command: 'review',
      version: assigned.json.version,
    });
    const filled = await managerA.put(`${P}/${id}/resolution`, {
      json: {
        version: review.json.version,
        resolutionSummary: 'Resuelto de forma sintética',
        vehicleStatusDecision: 'restricted',
      },
    });
    const done = await transition(managerA, id, {
      command: 'resolve',
      version: filled.json.version,
    });
    expect(done.status, done.text).toBe(200);
    return { id, version: done.json.version as number };
  }

  it('closes with one snapshot row, one event and the same answer under concurrency (cases 9 and 16 baseline)', async () => {
    const { id, version } = await resolved();
    const k = key();
    const [one, two] = await Promise.all([
      transition(managerA, id, { command: 'close', version }, k),
      transition(managerA, id, { command: 'close', version }, k),
    ]);
    expect([one.status, two.status], `${one.text} ${two.text}`).toEqual([200, 200]);
    expect(one.json).toEqual(two.json);
    expect(one.json).toMatchObject({ status: 'closed', cycle: 1 });
    const rows = await database.rows<Record<string, unknown>>(
      'SELECT * FROM opslog_incident_closures WHERE incident_id = ?',
      [id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      cycle: 1,
      status_before: 'resolved',
      resolved_from: 'under_review',
      vehicle_status_decision: 'restricted',
    });
    const closedEvents = await database.rows<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM opslog_tenant_outbox WHERE entity_id = ? AND type = 'incident.closed'",
      [id],
    );
    expect(closedEvents).toHaveLength(1);
    expect(Object.keys(closedEvents[0]?.payload ?? {}).sort()).toEqual([
      'incidentId',
      'vehicleId',
      'version',
    ]);
    // Closed is immutable: edits, children and every other command answer 409.
    for (const response of [
      await managerA.send('PATCH', `${P}/${id}`, {
        json: { version: one.json.version, description: 'x' },
      }),
      await managerA.put(`${P}/${id}/resolution`, {
        json: { version: one.json.version, totalLoss: true },
      }),
      await managerA.put(`${P}/${id}/insurance`, {
        json: { version: one.json.version, claimNumber: 'X' },
      }),
      await transition(managerA, id, { command: 'cancel', version: one.json.version, reason: 'x' }),
      await transition(managerA, id, { command: 'review', version: one.json.version }),
    ])
      expect(response.status, response.text).toBe(409);
    const foreign = await transition(managerB, id, { command: 'close', version }, key());
    expect(foreign.status).toBe(404);
  });

  it('reopens into a second cycle and closes again, leaving two intact snapshots and no free text in audit or outbox (case 12)', async () => {
    const { id, version } = await resolved();
    const closed = await transition(managerA, id, { command: 'close', version }, key());
    const denied = await transition(
      managerA,
      id,
      { command: 'reopen', version: closed.json.version, reason: REASON },
      key(),
    );
    expect(denied.status).toBe(403);
    const admin = fleet.adminA;
    const reopened = await transition(
      admin,
      id,
      { command: 'reopen', version: closed.json.version, reason: REASON },
      key(),
    );
    expect(reopened.status, reopened.text).toBe(200);
    expect(reopened.json).toMatchObject({ status: 'reopened', cycle: 2, reopenCount: 1 });
    const review = await transition(managerA, id, {
      command: 'review',
      version: reopened.json.version,
    });
    const filled = await managerA.put(`${P}/${id}/resolution`, {
      json: { version: review.json.version, resolutionSummary: 'Segunda resolución sintética' },
    });
    const again = await transition(managerA, id, {
      command: 'resolve',
      version: filled.json.version,
    });
    const second = await transition(
      managerA,
      id,
      { command: 'close', version: again.json.version },
      key(),
    );
    expect(second.json).toMatchObject({ status: 'closed', cycle: 2, reopenCount: 1 });
    const rows = await database.rows<{ cycle: number; resolution_summary: string }>(
      'SELECT cycle, resolution_summary FROM opslog_incident_closures WHERE incident_id = ? ORDER BY cycle',
      [id],
    );
    expect(rows.map((row) => [row.cycle, row.resolution_summary])).toEqual([
      [1, 'Resuelto de forma sintética'],
      [2, 'Segunda resolución sintética'],
    ]);
    const timeline = await database.rows<{ command: string }>(
      'SELECT command FROM opslog_incident_transitions WHERE incident_id = ? ORDER BY sequence',
      [id],
    );
    expect(timeline.map((row) => row.command).slice(-7)).toEqual([
      'resolve',
      'close',
      'reopen',
      'review',
      'resolution_updated',
      'resolve',
      'close',
    ]);
    for (const table of ['opslog_audit_local', 'opslog_tenant_outbox']) {
      const dump = JSON.stringify(await database.rows(`SELECT * FROM ${table}`));
      for (const secret of [REASON, FREE_TEXT, 'Segunda resolución sintética'])
        expect(dump, `${table} ${secret}`).not.toContain(secret);
    }
  });

  it('asks the D20 approval only when the real cost passes the threshold, and not at all without one (case 8)', async () => {
    const free = await resolved();
    expect(
      (await transition(managerA, free.id, { command: 'close', version: free.version }, key()))
        .status,
    ).toBe(200);

    const saved = await fleet.adminA.put('/api/alerts/settings', {
      json: {
        version: 0,
        expiryWindowDays: 7,
        recipientRoles: ['admin'],
        closeCostThreshold: { amountMinor: '500000', currency: 'MXN' },
      },
    });
    expect(saved.status, saved.text).toBe(200);
    const resolvedCase = await resolved();
    const { id } = resolvedCase;
    // Free cost: nothing is asked while the case bears no cost.
    expect(
      (await managerA.get(`${P}/${id}/next-steps`)).json.items.find(
        (item: { command: string }) => item.command === 'close',
      ),
    ).toEqual({ command: 'close', missingRequirements: [] });
    const priced = await managerA.put(`${P}/${id}/costs`, {
      json: {
        version: resolvedCase.version,
        lines: [
          {
            kind: 'expense',
            category: 'towing',
            amount: { amountMinor: '500001', currency: 'MXN' },
          },
        ],
      },
      headers: { 'idempotency-key': key() },
    });
    expect(priced.status, priced.text).toBe(200);
    const version = priced.json.version as number;
    const steps = await managerA.get(`${P}/${id}/next-steps`);
    expect(steps.json.items).toContainEqual({
      command: 'close',
      missingRequirements: ['close_approval'],
    });
    const refused = await transition(managerA, id, { command: 'close', version }, key());
    expect([refused.status, refused.json.missingRequirements]).toEqual([422, ['close_approval']]);
    expect(
      (await transition(managerA, id, { command: 'approve_close', version }, key())).status,
    ).toBe(403);
    const approved = await transition(
      fleet.adminA,
      id,
      { command: 'approve_close', version },
      key(),
    );
    expect(approved.status, approved.text).toBe(200);
    const closed = await transition(
      managerA,
      id,
      { command: 'close', version: approved.json.version },
      key(),
    );
    expect(closed.status, closed.text).toBe(200);
    const [row] = await database.rows<{ close_approved_by: string | null }>(
      'SELECT close_approved_by FROM opslog_incident_closures WHERE incident_id = ?',
      [id],
    );
    expect(row?.close_approved_by).toMatch(/^user-/);
    // The threshold goes away again, so later cases are not affected.
    const cleared = await fleet.adminA.put('/api/alerts/settings', {
      json: {
        version: saved.json.version,
        expiryWindowDays: 7,
        recipientRoles: ['admin'],
        closeCostThreshold: null,
      },
    });
    expect(cleared.status, cleared.text).toBe(200);
  });

  it('refuses active while another open case of the vehicle cannot operate (case 14)', async () => {
    const { id } = await resolved(vehicleA, { vehicleOperable: false });
    const other = await managerA.post(P, {
      json: { vehicleId: vehicleA, type: 'other', vehicleOperable: false },
    });
    expect(other.status, other.text).toBe(201);
    const current = (await managerA.get(`${P}/${id}`)).json;
    const set = await managerA.put(`${P}/${id}/resolution`, {
      json: { version: current.version, vehicleStatusDecision: 'active' },
    });
    const blocked = await transition(
      managerA,
      id,
      { command: 'close', version: set.json.version },
      key(),
    );
    expect([blocked.status, blocked.json.field]).toEqual([422, 'vehicle_blocked']);
    // Tenant B's vehicle is not held by anything of A.
    const created = await managerB.post(P, { json: { vehicleId: vehicleB, type: 'other' } });
    expect(created.status, created.text).toBe(201);
  });
});
