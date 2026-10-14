import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminUrl, startFleetDatabase, type FleetDatabase } from './mysql.js';
import { startFleetWorld, type FleetWorld } from './world.js';

const suite = adminUrl ? describe : describe.skip;
const P = '/api/v1/incidents';
const FREE_TEXT = 'Texto libre sintético del siniestro';

suite('incident cases on real MySQL with two synthetic tenants', () => {
  let database: FleetDatabase;
  let fleet: FleetWorld;
  let managerA: Awaited<ReturnType<FleetWorld['worldA']['loginAs']>>;
  let managerB: typeof managerA;
  let vehicleA: string;
  let vehicleB: string;

  beforeAll(async () => {
    database = await startFleetDatabase();
    fleet = await startFleetWorld(database);
    await fleet.worldA.member('subject-admin-a', 'incident_manager', 'subject-manager-a');
    managerA = await fleet.worldA.loginAs('subject-manager-a');
    await fleet.worldB.member('subject-admin-b', 'incident_manager', 'subject-manager-b');
    managerB = await fleet.worldB.loginAs('subject-manager-b');
    vehicleA = await fleet.vehicle(fleet.adminA, await fleet.area(fleet.adminA), 'INC-A');
    vehicleB = await fleet.vehicle(fleet.adminB, await fleet.area(fleet.adminB), 'INC-B');
  }, 120_000);

  afterAll(async () => {
    fleet?.world.dispose();
    await database?.close();
  }, 60_000);

  it('persists a draft in its own tenant database, hides it from the other tenant and keeps free text out of audit and outbox', async () => {
    const created = await managerA.post(P, {
      json: { vehicleId: vehicleA, type: 'collision', description: FREE_TEXT },
    });
    expect(created.status, created.text).toBe(201);
    const id = created.json.id as string;
    const edited = await managerA.send('PATCH', `${P}/${id}`, {
      json: { version: 1, description: `${FREE_TEXT} editado` },
    });
    expect(edited.status, edited.text).toBe(200);

    const rows = await database.rows<{ company_id: string }>(
      'SELECT company_id FROM opslog_incident_incidents WHERE id = ?',
      [id],
    );
    expect(rows).toEqual([{ company_id: fleet.tenantA }]);
    expect(
      await database.rowsB('SELECT id FROM opslog_incident_incidents WHERE id = ?', [id]),
    ).toEqual([]);
    expect((await fleet.adminB.get(`${P}/${id}`)).status).toBe(404);
    expect((await fleet.adminB.get(P)).json).toMatchObject({ total: 0, items: [] });
    expect((await fleet.viewerA.get(`${P}/${id}`)).status).toBe(200);
    expect(
      (await fleet.viewerA.post(P, { json: { vehicleId: vehicleA, type: 'collision' } })).status,
    ).toBe(403);

    const timeline = await database.rows<{ sequence: number }>(
      'SELECT sequence FROM opslog_incident_transitions WHERE incident_id = ? ORDER BY sequence',
      [id],
    );
    expect(timeline.length).toBeGreaterThanOrEqual(2);
    for (const table of ['opslog_audit_local', 'opslog_tenant_outbox']) {
      const dump = JSON.stringify(await database.rows(`SELECT * FROM ${table}`));
      expect(dump, table).not.toContain(FREE_TEXT);
    }
  });

  async function reference(browser: typeof managerA, vehicleId: string, tag: string) {
    const area = await fleet.area(browser);
    const driverId = await fleet.driver(browser, area, tag);
    const policy = await browser.post('/api/insurance-policies', {
      json: {
        vehicleId,
        insurer: 'Aseguradora Sintética',
        policyNumber: `SYNTH-POL-${tag}`,
        coverageType: 'comprehensive',
        startsOn: '2020-01-01',
        endsOn: '2099-12-31',
      },
    });
    expect(policy.status, policy.text).toBe(201);
    return { driverId, policyId: policy.json.id as string };
  }

  it("answers a uniform 404 and writes nothing when a tenant uses the other one's vehicle, driver or policy", async () => {
    const refsA = await reference(fleet.adminA, vehicleA, 'XA');
    const refsB = await reference(fleet.adminB, vehicleB, 'XB');
    const count = async () => [
      (await database.rows<{ n: number }>('SELECT COUNT(*) AS n FROM opslog_incident_incidents'))[0]
        ?.n,
      (
        await database.rowsB<{ n: number }>('SELECT COUNT(*) AS n FROM opslog_incident_incidents')
      )[0]?.n,
    ];
    const before = await count();
    const attempts = [
      { actor: managerA, json: { vehicleId: vehicleB, type: 'collision' } },
      {
        actor: managerA,
        json: { vehicleId: vehicleA, type: 'collision', driverId: refsB.driverId },
      },
      {
        actor: managerA,
        json: { vehicleId: vehicleA, type: 'collision', policyId: refsB.policyId },
      },
      { actor: managerB, json: { vehicleId: vehicleA, type: 'collision' } },
      {
        actor: managerB,
        json: { vehicleId: vehicleB, type: 'collision', driverId: refsA.driverId },
      },
      {
        actor: managerB,
        json: { vehicleId: vehicleB, type: 'collision', policyId: refsA.policyId },
      },
    ];
    const replies = [];
    for (const { actor, json } of attempts) replies.push(await actor.post(P, { json }));
    for (const reply of replies)
      expect([reply.status, reply.json.code]).toEqual([404, 'not_found']);
    expect(
      new Set(replies.map((reply) => reply.text.replace(/"correlationId":"[^"]*"/, ''))).size,
    ).toBe(1);
    expect(await count()).toEqual(before);
    const own = await managerA.post(P, {
      json: {
        vehicleId: vehicleA,
        type: 'collision',
        occurredAt: new Date().toISOString(),
        ...refsA,
      },
    });
    expect(own.status, own.text).toBe(201);
  });

  it('seals third party identity at rest, isolates tenants and serves only clean evidence', async () => {
    const created = await managerA.post(P, { json: { vehicleId: vehicleA, type: 'collision' } });
    const id = created.json.id as string;
    const T = `${P}/${id}/third-parties`;
    const party = await managerA.post(T, {
      json: {
        version: 1,
        kind: 'vehicle',
        name: 'Tercero Sintético Reservado',
        contact: '+525512340000',
        plates: 'SYN-777-Z',
        policyNumber: 'POL-TERCERO-SYNTH',
        damageDescription: 'Daño sintético en costado',
      },
    });
    expect(party.status, party.text).toBe(201);
    expect(party.json.item.identityRestricted).toBe(true);
    const stored = JSON.stringify(
      await database.rows('SELECT * FROM opslog_incident_third_parties WHERE incident_id = ?', [
        id,
      ]),
    );
    for (const secret of ['Reservado', '5512340000', 'SYN-777-Z', 'POL-TERCERO-SYNTH'])
      expect(stored).not.toContain(secret);
    expect(stored).toContain('pii1.');
    expect((await fleet.adminA.get(T)).json.items[0]).toMatchObject({
      name: 'Tercero Sintético Reservado',
      plates: 'SYN-777-Z',
    });
    expect((await fleet.adminB.get(T)).status).toBe(404);
    expect(
      await database.rowsB('SELECT id FROM opslog_incident_third_parties WHERE incident_id = ?', [
        id,
      ]),
    ).toEqual([]);

    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(512, 3),
    ]);
    const E = `${P}/${id}/evidence`;
    const upload = {
      version: party.json.version,
      category: 'photo',
      stage: 'on_site',
      name: 'foto.png',
      contentType: 'image/png',
      clientCompressed: true,
      contentBase64: png.toString('base64'),
    };
    const up = await managerA.post(E, { json: upload });
    expect(up.status, up.text).toBe(201);
    expect(up.json.item).toMatchObject({ fileStatus: 'pending_scan', counts: false });
    const evidenceId = up.json.item.id as string;
    expect((await managerA.get(`${E}/${evidenceId}/content`)).status).toBe(409);
    await fleet.platformA.pipeline.processScans();
    const content = await managerA.get(`${E}/${evidenceId}/content`);
    expect(content.status, content.text).toBe(200);
    expect(Buffer.from(content.json.contentBase64, 'base64').equals(png)).toBe(true);
    expect((await fleet.adminB.get(`${E}/${evidenceId}/content`)).status).toBe(404);
    expect((await fleet.adminB.post(E, { json: upload })).status).toBe(404);
    const audited = JSON.stringify(await database.rows('SELECT * FROM opslog_audit_local'));
    expect(audited).toContain('incident.evidence_downloaded');
    // The row names the link (case and evidence ids) and nothing of the file.
    expect(audited).toContain(`${id}.${evidenceId}`);
    const links = await database.rows<{ file_id: string }>(
      'SELECT file_id FROM opslog_incident_evidence WHERE incident_id = ?',
      [id],
    );
    expect(links).toHaveLength(1);
    expect(
      await database.rowsB('SELECT id FROM opslog_incident_evidence WHERE incident_id = ?', [id]),
    ).toEqual([]);
    for (const table of ['opslog_audit_local', 'opslog_tenant_outbox']) {
      const dump = JSON.stringify(await database.rows(`SELECT * FROM ${table}`));
      for (const secret of ['Reservado', 'SYN-777-Z', 'POL-TERCERO-SYNTH', 'Daño sintético'])
        expect(dump, table).not.toContain(secret);
    }
  });
});
