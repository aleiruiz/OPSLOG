import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminUrl, startFleetDatabase, type FleetDatabase } from './mysql.js';
import { startFleetWorld, type FleetWorld } from './world.js';

const suite = adminUrl ? describe : describe.skip;
const POLICIES = '/api/insurance-policies';

suite('integrated vehicle lifecycle on real MySQL', () => {
  let database: FleetDatabase;
  let fleet: FleetWorld;

  beforeAll(async () => {
    database = await startFleetDatabase();
    fleet = await startFleetWorld(database);
  }, 120_000);

  afterAll(async () => {
    fleet?.world.dispose();
    await database?.close();
  }, 60_000);

  it('creates a vehicle, document and expired policy, renews it, and derives the next alert window', async () => {
    const areaId = await fleet.area(fleet.adminA, 'Operaciones Norte');
    const vehicleId = await fleet.vehicle(fleet.adminA, areaId, 'LIFE01');
    const document = await fleet.adminA.post('/api/documents', {
      json: {
        ownerType: 'vehicle',
        ownerId: vehicleId,
        typeCode: 'registration_card',
        title: 'Tarjeta sintética',
        documentNumber: 'SYNTH-DOC-LIFE01',
        issuedOn: '2025-10-01',
        expiresOn: '2026-10-20',
      },
    });
    expect(document.status, document.text).toBe(201);

    const policy = await fleet.adminA.post(POLICIES, {
      json: {
        vehicleId,
        insurer: 'Aseguradora Sintética',
        policyNumber: 'SYNTH-POL-LIFE01',
        coverageType: 'comprehensive',
        startsOn: '2026-01-01',
        endsOn: '2026-10-05',
      },
    });
    expect(policy.status, policy.text).toBe(201);
    const policyId = policy.json.id as string;
    expect((await fleet.adminA.get(`${POLICIES}/${policyId}`)).json.status).toBe('expired');
    const beforeRenewalAlerts = await fleet.adminA.get('/api/alerts');
    expect(beforeRenewalAlerts.status, beforeRenewalAlerts.text).toBe(200);
    expect(
      beforeRenewalAlerts.json.items.map((item: { subjectId: string }) => item.subjectId),
    ).toContain(policyId);
    expect((await fleet.adminA.get(`/api/vehicles/${vehicleId}`)).json.status).toBe('active');

    const renewal = await fleet.adminA.post(`${POLICIES}/${policyId}/renew`, {
      json: { version: 1, startsOn: '2026-10-06', endsOn: '2026-11-05' },
    });
    expect(renewal.status, renewal.text).toBe(200);
    expect(renewal.json).toMatchObject({ id: policyId, revision: 2, status: 'expiring' });
    const history = await fleet.adminA.get(`${POLICIES}/${policyId}/history`);
    expect(history.json.items.map((item: { revision: number }) => item.revision)).toEqual([2, 1]);

    const alerts = await fleet.adminA.get('/api/alerts');
    expect(alerts.status, alerts.text).toBe(200);
    expect(alerts.json.asOf).toBe('2026-10-06');
    expect(alerts.json.items.map((item: { subjectId: string }) => item.subjectId)).toEqual(
      expect.arrayContaining([document.json.id, policyId]),
    );
    expect((await fleet.adminA.get(`/api/vehicles/${vehicleId}`)).json.status).toBe('active');

    const storedDocument = await database.rows<{ company_id: string; revision: number }>(
      'SELECT company_id, revision FROM opslog_documents WHERE id = ?',
      [document.json.id],
    );
    const documentRevisions = await database.rows<{ revision: number; expires_on: string }>(
      'SELECT revision, expires_on FROM opslog_document_revisions WHERE company_id = ? AND document_id = ? ORDER BY revision',
      [fleet.tenantA, document.json.id],
    );
    const policyRevisions = await database.rows<{ revision: number; ends_on: string }>(
      'SELECT revision, ends_on FROM opslog_insurance_policy_revisions WHERE company_id = ? AND policy_id = ? ORDER BY revision',
      [fleet.tenantA, policyId],
    );
    expect(storedDocument).toEqual([{ company_id: fleet.tenantA, revision: 1 }]);
    expect(documentRevisions).toHaveLength(1);
    expect(policyRevisions).toEqual([
      { revision: 1, ends_on: expect.any(String) },
      { revision: 2, ends_on: expect.any(String) },
    ]);
    expect(new Date(policyRevisions[0]?.ends_on as string).toISOString().slice(0, 10)).toBe(
      '2026-10-05',
    );
  });
});
