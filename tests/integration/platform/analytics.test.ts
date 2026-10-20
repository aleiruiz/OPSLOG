import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createBffWorld,
  type BffWorld,
  type Browser,
} from '../../../apps/api/bff/src/test-support.js';
import { InMemoryVehicleStore } from '../../../packages/domain/vehicles/src/index.js';

let world: BffWorld | undefined;
afterEach(() => {
  world?.dispose();
  world = undefined;
  vi.restoreAllMocks();
});

const P = '/api/v1/dashboard';
let serial = 0;

const created = (status: number, reply: { status: number; text: string }) => {
  if (reply.status !== status) throw new Error(`fixture failed: ${reply.status} ${reply.text}`);
};

async function post(browser: Browser, path: string, json: unknown, status = 201) {
  const reply = await browser.post(path, { json });
  created(status, reply);
  return reply.json as { id: string; version: number };
}

async function put(browser: Browser, path: string, json: unknown) {
  const reply = await browser.put(path, { json });
  created(200, reply);
  return reply.json as { version: number };
}

async function vehicle(browser: Browser, areaId: string) {
  serial += 1;
  return (
    await post(browser, '/api/vehicles', {
      economicNumber: `I-${serial}`,
      plate: `INT${serial}`,
      vin: null,
      make: 'Nissan',
      model: 'NP300',
      year: 2023,
      areaId,
      odometerKm: 5000,
    })
  ).id;
}

interface Widget {
  readonly id: string;
  readonly [key: string]: unknown;
}
const widgetsOf = async (browser: Browser, query = ''): Promise<Map<string, Widget>> => {
  const reply = await browser.get(`${P}${query}`);
  expect(reply.status, reply.text).toBe(200);
  return new Map((reply.json.widgets as Widget[]).map((widget) => [widget.id, widget]));
};

async function company(options: Parameters<typeof createBffWorld>[0] = {}) {
  world = createBffWorld(options);
  await world.tenant('Empresa Alfa', 'subject-admin-a');
  await world.tenant('Empresa Beta', 'subject-admin-b');
  await world.member('subject-admin-a', 'editor', 'subject-editor-a');
  const adminA = await world.loginAs('subject-admin-a');
  const adminB = await world.loginAs('subject-admin-b');
  const editorA = await world.loginAs('subject-editor-a');
  return { adminA, adminB, editorA };
}

describe('dashboard over every module of the platform', () => {
  it('computes each indicator from the real stores, hides costs from a reader without view_costs', async () => {
    const { adminA, adminB, editorA } = await company();
    const parent = (await post(adminA, '/api/areas', { name: 'Norte' })).id;
    const child = (await post(adminA, '/api/areas', { name: 'Norte 2', parentId: parent })).id;
    const car1 = await vehicle(adminA, child);
    const car2 = await vehicle(adminA, child);
    const car3 = await vehicle(adminA, parent);
    await post(adminA, '/api/employees', {
      kind: 'driver',
      firstName: 'Ana',
      lastName: 'Perez',
      areaId: child,
      employeeNumber: 'E-INT-1',
      idType: 'ine',
      nationalId: 'SYNTH-ID-7788-Q1',
      phone: '+525590001234',
      email: 'ana.perez.int@synthetic.example',
      licenseNumber: 'LIC-445566-1',
      licenseType: 'c',
      licenseExpiresOn: '2099-01-31',
    });
    await post(adminA, '/api/documents', {
      ownerType: 'vehicle',
      ownerId: car1,
      typeCode: 'registration_card',
      title: 'Tarjeta',
      expiresOn: '2026-10-10',
    });
    await post(adminA, '/api/insurance-policies', {
      vehicleId: car2,
      insurer: 'Aseguradora Ficticia',
      policyNumber: 'pol-int-1',
      coverageType: 'comprehensive',
      startsOn: '2026-01-01',
      endsOn: '2026-10-20',
    });
    // One plan due on 2026-10-15 (inside the 15 days) and a paused one that never counts.
    await post(adminA, '/api/v1/maintenance/plans', {
      vehicleId: car1,
      intervalDays: 30,
      lastServiceDate: '2026-09-15',
    });
    const paused = await post(adminA, '/api/v1/maintenance/plans', {
      vehicleId: car2,
      intervalDays: 30,
      lastServiceDate: '2026-09-15',
    });
    const pause = await adminA.post(`/api/v1/maintenance/plans/${paused.id}/pause`, {
      json: { version: paused.version },
    });
    created(200, pause);
    // A corrective order closed in the range, with an exact cost.
    const workshop = await post(adminA, '/api/v1/maintenance/workshops', {
      name: 'Taller Uno',
      specialties: ['frenos'],
    });
    const admin = (await world!.platform.session(tokenOf(adminA), 'fixture')).value?.actor
      .subject as string;
    const order = await post(adminA, '/api/v1/work-orders', {
      vehicleId: car3,
      description: 'Frenos',
    });
    const step = async (json: Record<string, unknown>) => {
      serial += 1;
      const reply = await adminA.post(`/api/v1/work-orders/${order.id}/transitions`, {
        json,
        headers: { 'idempotency-key': `key-integration-${serial}-analytics` },
      });
      created(200, reply);
      return reply.json as { version: number };
    };
    const assigned = await step({
      command: 'assign',
      version: 1,
      responsibleId: admin,
      workshopId: workshop.id,
      scheduledDate: '2026-10-13',
    });
    const started = await step({ command: 'start', version: assigned.version });
    const worked = await put(adminA, `/api/v1/work-orders/${order.id}/work`, {
      version: started.version,
      tasks: [{ description: 'Cambio de balatas' }],
      parts: [{ name: 'Balata', quantity: '4' }],
    });
    const costed = await put(adminA, `/api/v1/work-orders/${order.id}/costs`, {
      version: worked.version,
      costs: [{ category: 'labor', amount: { amountMinor: '150000', currency: 'MXN' } }],
    });
    const done = await step({
      command: 'complete',
      version: costed.version,
      actualDate: '2026-10-06',
      actualKm: 5100,
    });
    await step({ command: 'close', version: done.version, vehicleStatus: 'active' });
    // Two reported cases (one critical) and a draft.
    let keys = 0;
    for (const severity of ['critical', 'low', 'high']) {
      const draft = await post(adminA, '/api/v1/incidents', {
        vehicleId: car3,
        type: 'other',
        severity,
        occurredAt: new Date().toISOString(),
        location: { text: 'Calle Sintética' },
        description: 'Descripción sintética',
        vehicleOperable: true,
        noDriverReason: 'Vehículo estacionado',
        noPhotoJustification: 'Sin foto disponible',
      });
      if (severity === 'high') continue;
      keys += 1;
      const moved = await adminA.post(`/api/v1/incidents/${draft.id}/transitions`, {
        json: { version: draft.version, command: 'report' },
        headers: { 'idempotency-key': `key-incident-${keys}-analytics` },
      });
      created(200, moved);
    }
    await post(adminB, '/api/areas', { name: 'Ajena' });

    const all = await widgetsOf(adminA);
    expect(all.size).toBe(15);
    expect(all.get('vehicles_active')).toMatchObject({ value: 3 });
    expect(all.get('vehicles_out_of_service')).toMatchObject({ value: 0 });
    expect(all.get('drivers_active')).toMatchObject({ value: 1 });
    expect(all.get('maintenance_upcoming')).toMatchObject({ value: 1 });
    expect(all.get('documents_expiring')).toMatchObject({ value: 1 });
    expect(all.get('insurance_expiring')).toMatchObject({ value: 1 });
    expect(all.get('incidents_open')).toMatchObject({ value: 2 });
    expect(all.get('incidents_critical')).toMatchObject({ value: 1 });
    expect(all.get('insurance_valid_pct')).toMatchObject({ numerator: 1, denominator: 3 });
    // Only preventive orders are judged on time: the corrective one adds cost but no ratio term.
    expect(all.get('maintenance_on_time')).toMatchObject({
      numerator: 0,
      denominator: 0,
      percent: null,
    });
    expect(all.get('maintenance_cost')).toMatchObject({
      orders: 1,
      byCurrency: [{ currency: 'MXN', amountMinor: '150000' }],
    });
    expect(all.get('incidents_monthly')).toMatchObject({ reported: 2, closed: 0 });
    // The child area alone: two vehicles, the plan of car1 and the document of car1, no order, no case.
    const inChild = await widgetsOf(adminA, `?areaId=${child}`);
    expect(inChild.get('vehicles_active')).toMatchObject({ value: 2 });
    expect(inChild.get('maintenance_upcoming')).toMatchObject({ value: 1 });
    expect(inChild.get('incidents_open')).toMatchObject({ value: 0 });
    expect(inChild.get('maintenance_cost')).toMatchObject({ orders: 0 });
    // A reader without view_costs gets the maintenance indicators but not the cost one.
    const editor = await widgetsOf(editorA);
    expect(editor.has('maintenance_on_time')).toBe(true);
    expect(editor.has('maintenance_cost')).toBe(false);
    const text = (await editorA.get(P)).text;
    expect(text).not.toMatch(/150000|MXN|maintenance_cost|amountMinor/);
    // Tenant B sees none of it.
    const other = await widgetsOf(adminB);
    expect(other.get('vehicles_active')).toMatchObject({ value: 0 });
    expect(other.get('maintenance_cost')).toMatchObject({ orders: 0, byCurrency: [] });
    expect(other.get('incidents_open')).toMatchObject({ value: 0 });
  });

  it('pages through more than one window of areas to find a deep subtree', async () => {
    const { adminA } = await company();
    const root = (await post(adminA, '/api/areas', { name: 'Raíz' })).id;
    let last = root;
    for (let n = 1; n <= 3; n += 1)
      last = (await post(adminA, '/api/areas', { name: `Nivel ${n}`, parentId: last })).id;
    for (let n = 0; n < 101; n += 1) await post(adminA, '/api/areas', { name: `Suelta ${n}` });
    await vehicle(adminA, last);
    expect((await widgetsOf(adminA, `?areaId=${root}`)).get('vehicles_active')).toMatchObject({
      value: 1,
    });
  });

  it('answers 500 with a generic body when a store has no dashboard reads', async () => {
    const bare = new Proxy(new InMemoryVehicleStore(), {
      get: (target, key, receiver) =>
        key === 'analyticsVehicles' ? undefined : Reflect.get(target, key, receiver),
    });
    const { adminA } = await company({ adapters: { vehicles: bare } });
    const reply = await adminA.get(P);
    expect(reply.status).toBe(500);
    expect(reply.text).not.toMatch(/analyticsVehicles|dashboard reads/);
  });
});

function tokenOf(browser: Browser): string {
  const cookie = [...browser.jar.values()].find((value) => value.length > 20);
  if (!cookie) throw new Error('no session cookie in the fixture');
  return cookie;
}
