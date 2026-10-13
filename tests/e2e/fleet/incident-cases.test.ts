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
  let vehicleA: string;

  beforeAll(async () => {
    database = await startFleetDatabase();
    fleet = await startFleetWorld(database);
    await fleet.worldA.member('subject-admin-a', 'incident_manager', 'subject-manager-a');
    managerA = await fleet.worldA.loginAs('subject-manager-a');
    vehicleA = await fleet.vehicle(fleet.adminA, await fleet.area(fleet.adminA), 'INC-A');
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
});
