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

    for (const foreignRead of [
      fleet.adminB.get(`/api/areas/${areaA}`),
      fleet.adminB.get(`/api/vehicles/${vehicleA}`),
      fleet.adminB.get(`/api/employees/${driverA}`),
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
});
