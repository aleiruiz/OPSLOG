import mysql from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminUrl } from '../../e2e/fleet/mysql.js';
import { journeySteps, type JourneySteps } from '../../e2e/incidents/steps.js';
import { P, W, startIncidentsWorld, type IncidentsWorld } from '../../e2e/incidents/world.js';

const suite = adminUrl ? describe : describe.skip;
/** Everything but the per-request correlation id: the rest of the body must be the same. */
const withoutCorrelation = (body: unknown) =>
  Object.fromEntries(
    Object.entries((body ?? {}) as Record<string, unknown>).filter(
      ([key]) => key !== 'correlationId',
    ),
  );
const NO_ID = '00000000-0000-4000-8000-000000000000';

interface Probe {
  readonly name: string;
  readonly method: string;
  /** Path under the incident, with the ids of the owner's case. */
  readonly path: (ids: Ids) => string;
  readonly json?: (ids: Ids) => Record<string, unknown>;
}
interface Ids {
  readonly incident: string;
  readonly version: number;
  readonly party: string;
  readonly evidence: string;
  readonly link: string;
}

const probes: readonly Probe[] = [
  { name: 'get', method: 'GET', path: (i) => `${P}/${i.incident}` },
  { name: 'timeline', method: 'GET', path: (i) => `${P}/${i.incident}/timeline` },
  { name: 'next-steps', method: 'GET', path: (i) => `${P}/${i.incident}/next-steps` },
  { name: 'costs get', method: 'GET', path: (i) => `${P}/${i.incident}/costs` },
  { name: 'repairs list', method: 'GET', path: (i) => `${P}/${i.incident}/repairs` },
  { name: 'third parties list', method: 'GET', path: (i) => `${P}/${i.incident}/third-parties` },
  { name: 'evidence list', method: 'GET', path: (i) => `${P}/${i.incident}/evidence` },
  {
    name: 'evidence content',
    method: 'GET',
    path: (i) => `${P}/${i.incident}/evidence/${i.evidence}/content`,
  },
  {
    name: 'update',
    method: 'PATCH',
    path: (i) => `${P}/${i.incident}`,
    json: (i) => ({ version: i.version, severity: 'high' }),
  },
  {
    name: 'transition',
    method: 'POST',
    path: (i) => `${P}/${i.incident}/transitions`,
    json: (i) => ({ command: 'cancel', version: i.version, reason: 'x' }),
  },
  {
    name: 'insurance',
    method: 'PUT',
    path: (i) => `${P}/${i.incident}/insurance`,
    json: (i) => ({ version: i.version, claimNumber: 'B' }),
  },
  {
    name: 'resolution',
    method: 'PUT',
    path: (i) => `${P}/${i.incident}/resolution`,
    json: (i) => ({ version: i.version, totalLoss: true }),
  },
  {
    name: 'costs put',
    method: 'PUT',
    path: (i) => `${P}/${i.incident}/costs`,
    json: (i) => ({ version: i.version, lines: [] }),
  },
  {
    name: 'third party create',
    method: 'POST',
    path: (i) => `${P}/${i.incident}/third-parties`,
    json: (i) => ({ version: i.version, kind: 'vehicle', name: 'Tercero B', plates: 'SYN-B' }),
  },
  {
    name: 'third party update',
    method: 'PATCH',
    path: (i) => `${P}/${i.incident}/third-parties/${i.party}`,
    json: (i) => ({ version: i.version, name: 'Otro' }),
  },
  {
    name: 'third party remove',
    method: 'POST',
    path: (i) => `${P}/${i.incident}/third-parties/${i.party}/remove`,
    json: (i) => ({ version: i.version }),
  },
  {
    name: 'evidence detach',
    method: 'POST',
    path: (i) => `${P}/${i.incident}/evidence/${i.evidence}/detach`,
    json: (i) => ({ version: i.version }),
  },
  {
    name: 'repair link',
    method: 'POST',
    path: (i) => `${P}/${i.incident}/repairs`,
    json: (i) => ({ version: i.version, orderId: NO_ID }),
  },
  {
    name: 'repair unlink',
    method: 'POST',
    path: (i) => `${P}/${i.incident}/repairs/${i.link}/unlink`,
    json: (i) => ({ version: i.version }),
  },
];

suite('incidents A/B isolation matrix over every route (MySQL, two physical databases)', () => {
  let w: IncidentsWorld;
  let s: JourneySteps;
  let ids: Ids;
  let orderId: string;

  beforeAll(async () => {
    w = await startIncidentsWorld();
    s = journeySteps(w);
    const review = await s.underReview();
    const party = await w.manager.post(`${P}/${review.id}/third-parties`, {
      json: {
        version: review.version,
        kind: 'vehicle',
        name: 'Tercero sintético',
        plates: 'SYN-1',
      },
    });
    expect(party.status, party.text).toBe(201);
    const evidence = await s.evidence(w.manager, review.id, party.json.version, 'photo');
    const evidenceRows = await w.database.rows<{ id: string }>(
      'SELECT id FROM opslog_incident_evidence WHERE incident_id = ?',
      [review.id],
    );
    const order = await w.adminA.post(W, {
      json: { vehicleId: w.vehicleA, description: 'Orden A' },
    });
    orderId = order.json.id as string;
    const link = await w.manager.post(`${P}/${review.id}/repairs`, {
      json: { version: evidence.version, orderId },
      headers: w.key(),
    });
    expect(link.status, link.text).toBe(200);
    ids = {
      incident: review.id,
      version: link.json.version,
      party: party.json.item?.id ?? NO_ID,
      evidence: evidenceRows[0]?.id ?? NO_ID,
      link: link.json.item.id,
    };
  }, 180_000);
  afterAll(async () => {
    await w?.stop();
  }, 60_000);

  const send = (browser: typeof w.manager, probe: Probe, target: Ids) =>
    browser.send(probe.method, probe.path(target), {
      ...(probe.json ? { json: probe.json(target) } : {}),
      headers: w.key(),
    });
  const absent = (target: Ids): Ids => ({
    ...target,
    incident: NO_ID,
    party: NO_ID,
    evidence: NO_ID,
    link: NO_ID,
  });

  it.each(probes.map((probe) => [probe.name, probe] as const))(
    'answers 404 to the other company on %s, indistinguishable from a case that does not exist',
    async (_name, probe) => {
      const foreign = [await send(w.managerB, probe, ids), await send(w.adminB, probe, ids)];
      const missing = await send(w.managerB, probe, absent(ids));
      for (const reply of foreign) {
        expect(reply.status, reply.text).toBe(404);
        expect(withoutCorrelation(reply.json)).toEqual(withoutCorrelation(missing.json));
      }
      // The refused attempts changed nothing for the owner.
      const view = await s.read(w.manager, ids.incident);
      expect(view.version).toBe(ids.version);
    },
  );

  it('keeps lists, filters, suggestions and alerts of one company out of the other', async () => {
    const lists = [
      await w.managerB.get(P),
      await w.managerB.get(`${P}?vehicleId=${w.vehicleA}`),
      await w.managerB.get(`${P}?status=under_review`),
      await w.managerB.get(`${P}/alerts`),
    ];
    for (const reply of lists) {
      expect(reply.status, reply.text).toBe(200);
      expect(JSON.stringify(reply.json)).not.toContain(ids.incident);
      expect(reply.json.items).toEqual([]);
    }
    const suggestions = await w.managerB.get(
      `${P}/suggestions?vehicleId=${w.vehicleA}&occurredAt=${encodeURIComponent(w.now().toISOString())}`,
    );
    expect(suggestions.status).toBe(404);
    // B creates over A's vehicle: the vehicle does not exist for B.
    const over = await w.managerB.post(P, { json: { vehicleId: w.vehicleA, type: 'other' } });
    expect(over.status).toBe(404);
    const own = { json: await s.draft(w.managerB, { vehicleId: w.vehicleB, policyId: null }) };
    const mine = await w.manager.get(P);
    expect(JSON.stringify(mine.json)).not.toContain(own.json.id);
    // B cannot link A's order to a case of its own that is in a state that accepts links.
    const reported = await s.step(w.managerB, own.json.id, own.json.version, 'report');
    const assigned = await s.step(w.managerB, own.json.id, reported.version, 'assign', {
      responsibleId: w.managerBId,
    });
    const review = await s.step(w.managerB, own.json.id, assigned.version, 'review');
    const link = await w.managerB.post(`${P}/${own.json.id}/repairs`, {
      json: { version: review.version, orderId },
      headers: w.key(),
    });
    expect(link.status).toBe(404);
  });

  it('leaves the database of B without a single row of A, and the account of A without access to B', async () => {
    for (const table of [
      'opslog_incident_incidents',
      'opslog_incident_transitions',
      'opslog_incident_third_parties',
      'opslog_incident_evidence',
      'opslog_incident_repair_links',
      'opslog_incident_cost_lines',
      'opslog_incident_closures',
      'opslog_incident_idempotency',
    ])
      expect(JSON.stringify(await w.database.rowsB(`SELECT * FROM ${table}`)), table).not.toContain(
        ids.incident,
      );
    expect(
      await w.database.rowsB('SELECT 1 FROM opslog_maintenance_work_orders WHERE id = ?', [
        orderId,
      ]),
    ).toEqual([]);
    const account = w.database.accounts.incidents;
    const crossed = await mysql
      .createConnection({
        host: w.database.host,
        port: w.database.port,
        user: account.username,
        password: account.password,
        database: w.database.tenantB.databaseName,
      })
      .then(
        async (connection) => {
          await connection.end();
          return 'connected';
        },
        (error: Error) => error.message,
      );
    expect(crossed).toMatch(/denied/i);
  });
});
