import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminUrl, startFleetDatabase, type FleetDatabase } from './mysql.js';
import { startFleetWorld, type FleetWorld } from './world.js';

const suite = adminUrl ? describe : describe.skip;

suite('integrated tenant and permission boundaries on real MySQL', () => {
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

  it('keeps composed area, vehicle, and employee records inside their tenant and masks submitted PII', async () => {
    const areaA = await fleet.area(fleet.adminA, 'Área privada A');
    const areaB = await fleet.area(fleet.adminB, 'Área privada B');
    const vehicleA = await fleet.vehicle(fleet.adminA, areaA, 'SEC-A');
    const driverA = await fleet.driver(fleet.adminA, areaA, 'SEC-DRIVER');
    const document = await fleet.adminA.post('/api/documents', {
      json: {
        ownerType: 'vehicle',
        ownerId: vehicleA,
        typeCode: 'registration_card',
        title: 'Tarjeta sintética privada',
        documentNumber: 'SYNTH-DOC-SEC-A',
        issuedOn: '2025-10-01',
        expiresOn: '2027-10-01',
      },
    });
    expect(document.status, document.text).toBe(201);
    const policy = await fleet.adminA.post('/api/insurance-policies', {
      json: {
        vehicleId: vehicleA,
        insurer: 'Aseguradora Sintética',
        policyNumber: 'SYNTH-POL-SEC-A',
        coverageType: 'comprehensive',
        startsOn: '2026-01-01',
        endsOn: '2027-01-01',
      },
    });
    expect(policy.status, policy.text).toBe(201);

    for (const foreignRead of [
      fleet.adminB.get(`/api/areas/${areaA}`),
      fleet.adminB.get(`/api/vehicles/${vehicleA}`),
      fleet.adminB.get(`/api/employees/${driverA}`),
      fleet.adminB.get(`/api/documents/${document.json.id}`),
      fleet.adminB.get(`/api/insurance-policies/${policy.json.id}`),
    ])
      expect((await foreignRead).status).toBe(404);

    const deniedAreaWrite = await fleet.viewerA.post('/api/areas', {
      json: { name: 'Viewer no puede escribir' },
    });
    expect(deniedAreaWrite.status).toBe(403);
    const deniedVehicleWrite = await fleet.viewerA.post('/api/vehicles', {
      json: {
        economicNumber: 'FLT-VIEWER',
        plate: 'VIEWER1',
        vin: null,
        make: 'Toyota',
        model: 'Hilux',
        year: 2022,
        areaId: areaA,
        odometerKm: 0,
      },
    });
    expect(deniedVehicleWrite.status).toBe(403);

    const employeeView = await fleet.viewerA.get(`/api/employees/${driverA}`);
    expect(employeeView.status, employeeView.text).toBe(200);
    expect(employeeView.json.piiPresent).toEqual({
      nationalId: true,
      phone: true,
      email: true,
      licenseNumber: true,
    });
    expect(employeeView.text).not.toContain('SYNTH-ID');
    expect(employeeView.text).not.toContain('LIC-');
    expect(employeeView.text).not.toContain('+52 555 100');
    expect(employeeView.text).not.toContain('@synthetic.example');

    const vehicleRows = await database.rows<{ company_id: string; economic_number: string }>(
      'SELECT company_id, economic_number FROM opslog_vehicles WHERE id = ?',
      [vehicleA],
    );
    const employeeRows = await database.rows<{ company_id: string }>(
      'SELECT company_id FROM opslog_employees WHERE id = ?',
      [driverA],
    );
    expect(vehicleRows).toEqual([{ company_id: fleet.tenantA, economic_number: 'FLT-SEC-A' }]);
    expect(employeeRows).toEqual([{ company_id: fleet.tenantA }]);
    expect(areaB).not.toBe(areaA);
    const areaHistory = await fleet.adminA.get(`/api/areas/${areaA}/history`);
    expect(areaHistory.status).toBe(200);
    expect(areaHistory.json.items).toHaveLength(1);
    const employeeHistory = await fleet.adminA.get(`/api/employees/${driverA}/history`);
    expect(employeeHistory.status).toBe(200);
    expect(employeeHistory.json.items).toHaveLength(1);
  }, 60_000);

  it('relays module-local audit rows into the tenant projection and rejects another tenant resolver key', async () => {
    const areaId = await fleet.area(fleet.adminA, 'Auditoría durable');
    const areaIdB = await fleet.area(fleet.adminB, 'Auditoría durable B');
    const local = await database.rows<{ event_id: string; action: string }>(
      'SELECT event_id, action FROM opslog_audit_local WHERE tenant_id = ? AND action = ? AND entity_id = ? ORDER BY occurred_at DESC LIMIT 1',
      [fleet.tenantA, 'area.created', areaId],
    );
    expect(local).toHaveLength(1);
    const localB = await database.rowsB<{ event_id: string; action: string }>(
      'SELECT event_id, action FROM opslog_audit_local WHERE tenant_id = ? AND action = ? AND entity_id = ? ORDER BY occurred_at DESC LIMIT 1',
      [fleet.tenantB, 'area.created', areaIdB],
    );
    expect(localB).toHaveLength(1);

    const delivered = await fleet.platformA.runtime.runAuditRelay();
    expect(delivered).toBeGreaterThan(0);
    const deliveredB = await fleet.platformB.runtime.runAuditRelay();
    expect(deliveredB).toBeGreaterThan(0);
    const admin = await fleet.platformA.signIn(await fleet.worldA.principal('subject-admin-a'));
    expect(admin.ok).toBe(true);
    const trailA = await fleet.platformA.listAudit(admin.value!.token, 'fleet-audit-list-a');
    expect(trailA.ok).toBe(true);
    expect(trailA.value?.some((event) => event.eventId === local[0]?.event_id)).toBe(true);

    const adminB = await fleet.platformB.signIn(await fleet.worldB.principal('subject-admin-b'));
    expect(adminB.ok).toBe(true);
    const trailB = await fleet.platformB.listAudit(adminB.value!.token, 'fleet-audit-list-b');
    expect(trailB.ok).toBe(true);
    expect(trailB.value?.some((event) => event.eventId === local[0]?.event_id)).toBe(false);
    expect(trailB.value?.some((event) => event.eventId === localB[0]?.event_id)).toBe(true);
    expect(trailA.value?.some((event) => event.eventId === localB[0]?.event_id)).toBe(false);
    await expect(database.tenantA.runtime.audit.list(fleet.tenantB)).rejects.toThrow();
    expect(database.databaseName).not.toBe(database.tenantB.databaseName);
    expect(areaId).not.toBe(areaIdB);
  }, 60_000);
});
