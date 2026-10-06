import { describe, expect, it } from 'vitest';
import { demoVehicles, makeVehicle } from '../vehicles/fixtures';
import { createMockApi, demoCredentials } from './mockApi';
import { createMockVehicleStore } from './mockVehicles';
import type { VehicleInput } from './types';

const input: VehicleInput = {
  economicNumber: 'ECO-900',
  plate: 'zz 900',
  make: 'Toyota',
  model: 'Hiace',
  year: 2023,
  areaId: 'area-sur',
  odometerKm: 1200,
};
const failure = (status: number, code: string) => ({ ok: false, error: { status, code } });

describe('mock vehicle store', () => {
  it('lists in economic-number order with filters, archived rows hidden by default and cursor pages', async () => {
    const { port } = createMockVehicleStore([
      ...demoVehicles(28),
      makeVehicle({
        id: 'veh-arch',
        economicNumber: 'ECO-999',
        archivedAt: '2026-09-30T00:00:00.000Z',
      }),
    ]);
    const first = await port.list({ limit: 25 });
    expect(first).toMatchObject({ ok: true, value: { total: 28, nextCursor: 'mock:25' } });
    const second = await port.list({ limit: 25, cursor: 'mock:25' });
    expect(second.ok && second.value.items.map((item) => item.economicNumber)).toEqual([
      'ECO-026',
      'ECO-027',
      'ECO-028',
    ]);
    expect(second.ok && second.value.nextCursor).toBeNull();
    const withArchived = await port.list({ includeArchived: 'true', limit: 100 });
    expect(withArchived.ok && withArchived.value.total).toBe(29);
    const maintenance = await port.list({ status: 'in_maintenance' });
    expect(
      maintenance.ok && maintenance.value.items.every((item) => item.status === 'in_maintenance'),
    ).toBe(true);
    const area = await port.list({ areaId: 'area-sur', status: 'active' });
    expect(area.ok && area.value.items.every((item) => item.areaId === 'area-sur')).toBe(true);
  });

  it('rejects malformed queries with a uniform 400', async () => {
    const { port } = createMockVehicleStore();
    for (const query of [
      { limit: 10 as 25 },
      { cursor: 'otro' },
      { status: 'volando' as 'active' },
      { areaId: 'área' },
      { includeArchived: 'si' as 'true' },
    ])
      expect(await port.list(query)).toMatchObject(failure(400, 'bad_request'));
  });

  it('creates an active vehicle with version 1, normalized plate and today as default date', async () => {
    const store = createMockVehicleStore([]);
    const created = await store.port.create(input);
    expect(created).toMatchObject({
      ok: true,
      value: {
        economicNumber: 'ECO-900',
        plate: 'ZZ 900',
        vin: null,
        status: 'active',
        statusReason: 'Alta',
        version: 1,
        archivedAt: null,
        registeredOn: '2026-10-06',
      },
    });
    expect(store.snapshot()).toHaveLength(1);
    const withVin = await store.port.create({
      ...input,
      economicNumber: 'ECO-901',
      plate: 'ZZ 901',
      vin: '3n6pd23w05zb10005',
      registeredOn: '2026-01-02',
    });
    expect(withVin).toMatchObject({
      ok: true,
      value: { vin: '3N6PD23W05ZB10005', registeredOn: '2026-01-02' },
    });
  });

  it('rejects invalid bodies, unknown fields and missing required fields', async () => {
    const { port } = createMockVehicleStore([]);
    const bad: Record<string, unknown>[] = [
      { ...input, economicNumber: '*' },
      { ...input, plate: '*' },
      { ...input, vin: 'corto' },
      { ...input, vin: 5 },
      { ...input, make: '' },
      { ...input, year: 1800 },
      { ...input, year: '2023' },
      { ...input, areaId: 'á' },
      { ...input, odometerKm: -1 },
      { ...input, odometerKm: 'x' },
      { ...input, registeredOn: '2099-01-01' },
      { ...input, registeredOn: 5 },
    ];
    for (const body of bad)
      expect(await port.create(body as unknown as VehicleInput)).toMatchObject(
        failure(400, 'bad_request'),
      );
    const missing: Record<string, unknown> = { ...input };
    delete missing['make'];
    expect(await port.create(missing as unknown as VehicleInput)).toMatchObject(
      failure(400, 'bad_request'),
    );
  });

  it('refuses duplicates per company, naming only the field: economic number, plate and VIN', async () => {
    const store = createMockVehicleStore([makeVehicle({ vin: '3N6PD23W05ZB10005' })]);
    const clash = async (change: Partial<VehicleInput>) =>
      store.port.create({ ...input, ...change });
    const economic = await clash({ economicNumber: 'eco-001' });
    expect(economic).toMatchObject({ ok: false, error: { status: 409, code: 'duplicate' } });
    expect(!economic.ok && economic.error.fieldErrors).toEqual([
      { field: 'economic_number', code: 'duplicate', message: 'Conflict' },
    ]);
    const plate = await clash({ plate: 'abc101' });
    expect(!plate.ok && plate.error.fieldErrors?.[0]?.field).toBe('plate');
    const vin = await clash({ vin: '3N6PD23W05ZB10005' });
    expect(!vin.ok && vin.error.fieldErrors?.[0]?.field).toBe('vin');
    expect(JSON.stringify([economic, plate, vin])).not.toMatch(/ECO-001|ABC-101|3N6PD/);
  });

  it('reads, and answers the same 404 for an unknown id on every operation', async () => {
    const { port } = createMockVehicleStore();
    expect(await port.get('veh-001')).toMatchObject({
      ok: true,
      value: { economicNumber: 'ECO-001' },
    });
    for (const result of [
      await port.get('nada'),
      await port.update('nada', { version: 1, make: 'X' }),
      await port.recordOdometer('nada', { version: 1, odometerKm: 1 }),
      await port.archive('nada', 1),
    ])
      expect(result).toMatchObject(failure(404, 'not_found'));
  });

  it('updates in place with optimistic versions and read-only archived or decommissioned vehicles', async () => {
    const store = createMockVehicleStore([
      makeVehicle(),
      makeVehicle({
        id: 'veh-002',
        economicNumber: 'ECO-002',
        plate: 'ABC-102',
        status: 'decommissioned',
      }),
      makeVehicle({
        id: 'veh-003',
        economicNumber: 'ECO-003',
        plate: 'ABC-103',
        archivedAt: '2026-09-30T00:00:00.000Z',
      }),
    ]);
    const { port } = store;
    expect(
      await port.update('veh-001', { version: 1, make: ' Toyota ', vin: null, year: 2024 }),
    ).toMatchObject({
      ok: true,
      value: { make: 'Toyota', year: 2024, version: 2 },
    });
    expect(await port.update('veh-001', { version: 1, make: 'Otra' })).toMatchObject(
      failure(409, 'stale_version'),
    );
    expect(await port.update('veh-001', { version: 2, economicNumber: 'eco-002' })).toMatchObject(
      failure(409, 'duplicate'),
    );
    // Changing a vehicle's own plate or number is not a collision with itself.
    expect(await port.update('veh-001', { version: 2, plate: 'abc-101' })).toMatchObject({
      ok: true,
    });
    expect(await port.update('veh-002', { version: 1, make: 'X' })).toMatchObject(
      failure(409, 'immutable'),
    );
    expect(await port.update('veh-003', { version: 1, make: 'X' })).toMatchObject(
      failure(409, 'immutable'),
    );
    for (const patch of [
      { version: 0, make: 'X' },
      { version: 3 },
      { version: 3, make: '' },
      { version: 3, model: 'a\nb' },
    ])
      expect(await port.update('veh-001', patch)).toMatchObject(failure(400, 'bad_request'));
  });

  it('never lets the odometer go down, treats an equal reading as a no-op and checks versions first', async () => {
    const store = createMockVehicleStore([makeVehicle({ odometerKm: 1000 })]);
    const { port } = store;
    expect(await port.recordOdometer('veh-001', { version: 1, odometerKm: 999 })).toMatchObject(
      failure(422, 'odometer_decrease'),
    );
    expect(await port.recordOdometer('veh-001', { version: 1, odometerKm: 1000 })).toMatchObject({
      ok: true,
      value: { version: 1, odometerKm: 1000 },
    });
    expect(await port.recordOdometer('veh-001', { version: 1, odometerKm: 1500 })).toMatchObject({
      ok: true,
      value: { version: 2, odometerKm: 1500 },
    });
    expect(await port.recordOdometer('veh-001', { version: 1, odometerKm: 2000 })).toMatchObject(
      failure(409, 'stale_version'),
    );
    expect(await port.recordOdometer('veh-001', { version: 2, odometerKm: -5 })).toMatchObject(
      failure(400, 'bad_request'),
    );
    expect(await port.recordOdometer('veh-001', { version: 0, odometerKm: 5 })).toMatchObject(
      failure(400, 'bad_request'),
    );
    store.archiveExternally('veh-001');
    expect(await port.recordOdometer('veh-001', { version: 3, odometerKm: 2000 })).toMatchObject(
      failure(409, 'immutable'),
    );
  });

  it('archives once, with the version, and simulates changes made by someone else', async () => {
    const store = createMockVehicleStore([
      makeVehicle(),
      makeVehicle({ id: 'veh-002', economicNumber: 'ECO-002', plate: 'ABC-102' }),
    ]);
    const { port } = store;
    store.changeExternally('veh-001', { odometerKm: 90000, make: 'Ajena' });
    expect(await port.archive('veh-001', 1)).toMatchObject(failure(409, 'stale_version'));
    expect(await port.archive('veh-001', 0)).toMatchObject(failure(400, 'bad_request'));
    const archived = await port.archive('veh-001', 2);
    expect(archived).toMatchObject({ ok: true, value: { version: 3, odometerKm: 90000 } });
    expect(archived.ok && archived.value.archivedAt).not.toBeNull();
    expect(await port.archive('veh-001', 3)).toMatchObject(failure(409, 'immutable'));
    store.changeExternally('nada', { odometerKm: 1 });
    store.archiveExternally('nada');
    store.archiveExternally('veh-002');
    expect(store.snapshot().filter((vehicle) => vehicle.archivedAt !== null)).toHaveLength(2);
  });
});

describe('mock API vehicle permissions', () => {
  const signedIn = async (account: keyof typeof demoCredentials) => {
    const api = createMockApi();
    await api.auth.login(demoCredentials[account]);
    return api;
  };

  it('requires a session', async () => {
    const api = createMockApi();
    expect(await api.vehicles.list({})).toMatchObject(failure(401, 'unauthorized'));
  });

  it('maps read to view, create to create, change to edit and archive to delete', async () => {
    const viewer = await signedIn('viewer');
    expect(await viewer.vehicles.list({})).toMatchObject({ ok: true });
    expect(await viewer.vehicles.get('veh-001')).toMatchObject({ ok: true });
    expect(await viewer.vehicles.create(input)).toMatchObject(failure(403, 'forbidden'));
    expect(await viewer.vehicles.update('veh-001', { version: 1, make: 'X' })).toMatchObject(
      failure(403, 'forbidden'),
    );
    expect(
      await viewer.vehicles.recordOdometer('veh-001', { version: 1, odometerKm: 99999 }),
    ).toMatchObject(failure(403, 'forbidden'));
    expect(await viewer.vehicles.archive('veh-001', 1)).toMatchObject(failure(403, 'forbidden'));
    const admin = await signedIn('admin');
    expect(await admin.vehicles.create(input)).toMatchObject({ ok: true });
    expect(await admin.vehicles.update('veh-001', { version: 1, make: 'X' })).toMatchObject({
      ok: true,
    });
    expect(
      await admin.vehicles.recordOdometer('veh-001', { version: 2, odometerKm: 99999 }),
    ).toMatchObject({ ok: true });
    expect(await admin.vehicles.archive('veh-001', 3)).toMatchObject({ ok: true });
    expect(
      admin.controls.vehicles().find((vehicle) => vehicle.id === 'veh-001')?.archivedAt,
    ).not.toBeNull();
  });

  it('supports an empty fleet, failure injection and external changes through the controls', async () => {
    const empty = createMockApi({ vehicles: [] });
    await empty.auth.login(demoCredentials.admin);
    expect(await empty.vehicles.list({})).toMatchObject({
      ok: true,
      value: { total: 0, items: [] },
    });
    const api = await signedIn('admin');
    api.controls.failNext('getVehicle', 500);
    expect(await api.vehicles.get('veh-001')).toMatchObject(failure(500, 'injected_failure'));
    api.controls.changeVehicleExternally('veh-001', { odometerKm: 77777 });
    expect(await api.vehicles.get('veh-001')).toMatchObject({
      ok: true,
      value: { odometerKm: 77777, version: 2 },
    });
    api.controls.archiveVehicleExternally('veh-001');
    expect(api.controls.vehicles()[0]?.archivedAt).not.toBeNull();
  });
});

describe('mock vehicles: area validation', () => {
  it('refuses an area that is not active (422 invalid_area, field area_id) on create and on a change of area', async () => {
    const { port } = createMockVehicleStore(undefined, undefined, (id) => id === 'area-norte');
    const input = {
      economicNumber: 'ECO-777',
      plate: 'QQ-777',
      make: 'Ford',
      model: 'Ranger',
      year: 2022,
      areaId: 'area-otra',
      odometerKm: 1,
    };
    const refused = await port.create(input);
    expect(refused).toMatchObject({
      ok: false,
      error: { status: 422, code: 'invalid_area', fieldErrors: [{ field: 'area_id' }] },
    });
    expect((await port.create({ ...input, areaId: 'area-norte' })).ok).toBe(true);
    const current = await port.get('veh-001');
    if (!current.ok) throw new Error('missing');
    const { version } = current.value;
    expect(await port.update('veh-001', { version, areaId: 'area-otra' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_area' },
    });
    // Keeping the area it already has is not revalidated.
    expect(
      (await port.update('veh-001', { version, areaId: current.value.areaId, make: 'Kia' })).ok,
    ).toBe(true);
  });
});
