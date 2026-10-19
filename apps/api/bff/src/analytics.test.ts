import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BFF_ROUTES,
  BFF_WIDGET_IDS,
  type BffDashboard,
} from '../../../../packages/contracts/src/index.js';
import { WIDGET_IDS } from '../../../../packages/domain/analytics/src/index.js';
import { createBffWorld, type BffWorld, type Browser, type Reply } from './test-support.js';

let world: BffWorld;
afterEach(() => {
  world?.dispose();
  vi.restoreAllMocks();
});

const P = '/api/v1/dashboard';
const MINUTE = 60_000;
let serial = 0;

async function area(browser: Browser, name: string, parentId: string | null = null) {
  const reply = await browser.post('/api/areas', { json: { name, parentId } });
  if (reply.status !== 201) throw new Error(`area fixture failed: ${reply.status}`);
  return reply.json.id as string;
}

async function vehicle(browser: Browser, areaId: string) {
  serial += 1;
  const reply = await browser.post('/api/vehicles', {
    json: {
      economicNumber: `D-${serial}`,
      plate: `DSH${serial}`,
      vin: null,
      make: 'Toyota',
      model: 'Hilux',
      year: 2022,
      areaId,
      odometerKm: 10,
    },
  });
  if (reply.status !== 201) throw new Error(`vehicle fixture failed: ${reply.status}`);
  return reply.json.id as string;
}

async function driver(browser: Browser, areaId: string) {
  serial += 1;
  const reply = await browser.post('/api/employees', {
    json: {
      kind: 'driver',
      firstName: 'Ana',
      lastName: 'Perez',
      areaId,
      employeeNumber: `E-${serial}`,
      idType: 'ine',
      nationalId: `SYNTH-ID-7788-Q${serial}`,
      phone: '+525590001234',
      email: `ana.perez${serial}@synthetic.example`,
      licenseNumber: `LIC-445566-${serial}`,
      licenseType: 'c',
      licenseExpiresOn: '2099-01-31',
    },
  });
  if (reply.status !== 201) throw new Error(`employee fixture failed: ${reply.status}`);
}

const dashboard = (reply: Reply): BffDashboard => reply.json as BffDashboard;
const ids = (reply: Reply): string[] => dashboard(reply).widgets.map((widget) => widget.id);
const count = (reply: Reply, id: string): number => {
  const widget = dashboard(reply).widgets.find((item) => item.id === id);
  if (widget?.kind !== 'count') throw new Error(`${id} is not a count widget`);
  return widget.value;
};

async function company() {
  world = createBffWorld();
  await world.tenant('Empresa Alfa', 'subject-admin-a');
  await world.tenant('Empresa Beta', 'subject-admin-b');
  const roles = ['editor', 'viewer', 'auditor', 'pii_reader', 'incident_manager'] as const;
  for (const role of roles) await world.member('subject-admin-a', role, `subject-${role}-a`);
  const adminA = await world.loginAs('subject-admin-a');
  const adminB = await world.loginAs('subject-admin-b');
  const as = async (role: (typeof roles)[number]) => world.loginAs(`subject-${role}-a`);
  return { adminA, adminB, as };
}

describe('contract', () => {
  it('declares one session route and the widget ids of the domain, in the same order', () => {
    expect(BFF_ROUTES['dashboard.get']).toEqual({
      method: 'GET',
      path: ['api', 'v1', 'dashboard'],
      kind: 'session',
      status: 200,
    });
    expect([...BFF_WIDGET_IDS]).toEqual([...WIDGET_IDS]);
  });
});

describe('dashboard over HTTP', () => {
  it('needs a session', async () => {
    world = createBffWorld();
    expect((await world.browser().get(P)).status).toBe(401);
  });

  it('rejects unknown, repeated and malformed query values and a foreign or unknown area', async () => {
    const { adminA, adminB } = await company();
    const other = await area(adminB, 'Ajena');
    for (const query of [
      '?tenantId=x',
      '?areaId=a&areaId=b',
      '?from=2026-10-01&from=2026-10-02',
      '?from=2026-1-01',
      '?to=hoy',
      '?areaId=%20',
      '?from=2026-10-10&to=2026-10-01',
      '?from=2024-01-01&to=2026-10-01',
      '?from=2026-02-30',
    ]) {
      const reply = await adminA.get(`${P}${query}`);
      expect([query, reply.status]).toEqual([query, 400]);
    }
    for (const id of [other, 'area-que-no-existe']) {
      const reply = await adminA.get(`${P}?areaId=${id}`);
      expect(reply.status).toBe(422);
      expect(reply.json).toMatchObject({ code: 'invalid_area' });
    }
  });

  it('says "sin datos" for an empty company instead of 0 % or 100 %', async () => {
    const { adminA } = await company();
    const reply = await adminA.get(P);
    expect(reply.status).toBe(200);
    expect(reply.headers['cache-control']).toBe('no-store');
    const body = dashboard(reply);
    expect(body.asOf).toBe('2026-10-06T12:00:00.000Z');
    expect(body.range).toEqual({ from: '2026-09-07', to: '2026-10-06' });
    expect(ids(reply)).toEqual([...WIDGET_IDS]);
    for (const widget of body.widgets) {
      if (widget.kind === 'ratio') expect([widget.id, widget.percent]).toEqual([widget.id, null]);
      if (widget.kind === 'availability') expect(widget.percent).toBeNull();
      if (widget.kind === 'count') expect(widget.value).toBe(0);
      if (widget.kind === 'duration') expect(widget.medianDays).toBeNull();
      if (widget.kind === 'money') expect(widget.byCurrency).toEqual([]);
    }
  });

  it('counts a parent area with its children, a child alone and the whole company', async () => {
    const { adminA } = await company();
    const parent = await area(adminA, 'Norte');
    const child = await area(adminA, 'Norte Sur', parent);
    const grandchild = await area(adminA, 'Norte Sur Este', child);
    const apart = await area(adminA, 'Centro');
    await vehicle(adminA, parent);
    await vehicle(adminA, child);
    await vehicle(adminA, grandchild);
    await vehicle(adminA, apart);
    await driver(adminA, child);
    await driver(adminA, apart);
    const active = async (query: string, id = 'vehicles_active') =>
      count(await adminA.get(`${P}${query}`), id);
    expect(await active('')).toBe(4);
    expect(await active(`?areaId=${parent}`)).toBe(3);
    expect(await active(`?areaId=${child}`)).toBe(2);
    expect(await active(`?areaId=${grandchild}`)).toBe(1);
    expect(await active(`?areaId=${apart}`)).toBe(1);
    expect(await active('', 'drivers_active')).toBe(2);
    expect(await active(`?areaId=${parent}`, 'drivers_active')).toBe(1);
    expect(dashboard(await adminA.get(`${P}?areaId=${parent}`)).areaId).toBe(parent);
  });

  it('sends each role only the widgets its permissions allow, with no trace of the others', async () => {
    const { adminA, as } = await company();
    const costs = ['maintenance_cost'];
    const incidents = [
      'incidents_open',
      'incidents_critical',
      'incidents_monthly',
      'incidents_resolution_time',
    ];
    const everyone = WIDGET_IDS.filter((id) => ![...costs, ...incidents].includes(id));
    expect(ids(await adminA.get(P))).toEqual([...WIDGET_IDS]);
    const seen = {
      editor: [...everyone, ...incidents],
      viewer: [...everyone, ...incidents],
      incident_manager: [...everyone, ...incidents],
      auditor: everyone,
      pii_reader: everyone,
    } as const;
    for (const [role, expected] of Object.entries(seen)) {
      const reply = await (await as(role as keyof typeof seen)).get(P);
      expect([role, ids(reply).sort()]).toEqual([role, [...expected].sort()]);
      const hidden = WIDGET_IDS.filter((id) => !expected.includes(id));
      for (const id of hidden) expect(reply.text).not.toContain(id);
    }
    // The dispatcher-like roles see neither a cost nor an incident figure, not even as a name.
    const text = (await (await as('pii_reader')).get(P)).text;
    expect(text).not.toMatch(/incidents_|maintenance_cost|byCurrency|amountMinor/);
  });

  it('reuses the figures for five minutes per company, reader rights and filters', async () => {
    const { adminA, adminB, as } = await company();
    const first = await area(adminA, 'Flota A');
    const second = await area(adminB, 'Flota B');
    await vehicle(adminA, first);
    const warm = await adminA.get(P);
    expect(count(warm, 'vehicles_active')).toBe(1);
    // Tenant B has its own figures even while A's are warm.
    expect(count(await adminB.get(P), 'vehicles_active')).toBe(0);
    await vehicle(adminA, first);
    await vehicle(adminB, second);
    world.advance(4 * MINUTE);
    const cached = await adminA.get(P);
    expect(count(cached, 'vehicles_active')).toBe(1);
    expect(dashboard(cached).asOf).toBe(dashboard(warm).asOf);
    expect(count(await adminB.get(P), 'vehicles_active')).toBe(0);
    // Another filter is another entry.
    expect(count(await adminA.get(`${P}?areaId=${first}`), 'vehicles_active')).toBe(2);
    // The same figures are not served to a reader with other rights.
    expect(ids(await (await as('pii_reader')).get(P))).not.toContain('incidents_open');
    world.advance(MINUTE + 1);
    const fresh = await adminA.get(P);
    expect(count(fresh, 'vehicles_active')).toBe(2);
    expect(dashboard(fresh).asOf).not.toBe(dashboard(warm).asOf);
    expect(count(await adminB.get(P), 'vehicles_active')).toBe(1);
  });

  it('counts open and critical cases, the SLA breach and the monthly flow of the incidents', async () => {
    const { adminA, adminB } = await company();
    const place = await area(adminA, 'Siniestros');
    const car = await vehicle(adminA, place);
    let keys = 0;
    const report = async (browser: Browser, vehicleId: string, severity: string, send = true) => {
      const created = await browser.post('/api/v1/incidents', {
        json: {
          vehicleId,
          type: 'other',
          severity,
          occurredAt: new Date().toISOString(),
          location: { text: 'Calle Sintética' },
          description: 'Descripción sintética',
          vehicleOperable: true,
          noDriverReason: 'Vehículo estacionado',
          noPhotoJustification: 'Sin foto disponible',
        },
      });
      expect(created.status, created.text).toBe(201);
      if (!send) return;
      keys += 1;
      const moved = await browser.post(`/api/v1/incidents/${created.json.id}/transitions`, {
        json: { version: created.json.version, command: 'report' },
        headers: { 'idempotency-key': `key-dashboard-${keys}-${Date.now()}` },
      });
      expect(moved.status, moved.text).toBe(200);
    };
    await report(adminA, car, 'low');
    await report(adminA, car, 'critical');
    await report(adminA, car, 'medium');
    await report(adminA, car, 'high', false);
    const other = await vehicle(adminB, await area(adminB, 'Otra'));
    await report(adminB, other, 'critical');
    const now = await adminA.get(P);
    const open = (reply: Reply) => [
      count(reply, 'incidents_open'),
      count(reply, 'incidents_critical'),
    ];
    // Three reported cases are open; the draft is not; only the critical one is critical so far.
    expect(open(now)).toEqual([3, 1]);
    expect(open(await adminB.get(P))).toEqual([1, 1]);
    expect(open(await adminA.get(`${P}?areaId=${place}`))).toEqual([3, 1]);
    // 31 days later the medium case is past its 30-day SLA: it counts as critical too.
    world.advance(31 * 24 * 60 * MINUTE);
    const later = await world.loginAs('subject-admin-a');
    const reply = await later.get(`${P}?from=2026-10-01&to=2026-11-30`);
    expect(open(reply)).toEqual([3, 2]);
    const monthly = dashboard(reply).widgets.find((widget) => widget.id === 'incidents_monthly');
    expect(monthly).toMatchObject({
      reported: 3,
      closed: 0,
      months: [
        { month: '2026-10', reported: 3, closed: 0 },
        { month: '2026-11', reported: 0, closed: 0 },
      ],
    });
  });

  it('applies a revocation at once, inside the cache window', async () => {
    const { adminA, as } = await company();
    const viewer = await as('viewer');
    expect(ids(await viewer.get(P))).toContain('incidents_open');
    const identityId = (await world.platform.session(tokenOf(viewer), 'fixture')).value?.actor
      .subject as string;
    const admin = await world.platform.signIn(await world.principal('subject-admin-a'));
    const token = admin.value?.token as string;
    expect((await world.platform.changeRole(token, 'fixture', identityId, 'auditor')).ok).toBe(
      true,
    );
    // Inside the five minutes the old session is gone and the new one never sees the cached incidents.
    world.advance(MINUTE);
    expect((await viewer.get(P)).status).toBe(401);
    const auditor = await world.loginAs('subject-viewer-a');
    const after = await auditor.get(P);
    expect(after.status).toBe(200);
    expect(ids(after)).not.toContain('incidents_open');
    expect(after.text).not.toContain('incidents_');
    expect(ids(await adminA.get(P))).toContain('incidents_open');
    // A removed member has no session: nothing is served from the cache.
    expect((await world.platform.removeMember(token, 'fixture', identityId)).ok).toBe(true);
    expect((await auditor.get(P)).status).toBe(401);
  });
});

function tokenOf(browser: Browser): string {
  const cookie = [...browser.jar.values()].find((value) => value.length > 20);
  if (!cookie) throw new Error('no session cookie in the fixture');
  return cookie;
}
