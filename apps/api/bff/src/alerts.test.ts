import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BFF_ALERT_RECIPIENT_ROLES,
  BFF_ALERT_SEVERITIES,
  BFF_ALERT_SOURCES,
  BFF_ROUTES,
} from '../../../../packages/contracts/src/index.js';
import {
  ALERT_RECIPIENT_ROLES,
  DEFAULT_RECIPIENT_ROLES,
} from '../../../../packages/domain/settings/src/index.js';
import { ALERT_SEVERITIES, ALERT_SOURCES } from '../../../../packages/domain/alerts/src/index.js';
import { ROLE_PERMISSIONS } from '../../composition/src/index.js';
import { createBffWorld, type BffWorld, type Browser, type Reply } from './test-support.js';

let world: BffWorld;
afterEach(() => {
  world?.dispose();
  vi.restoreAllMocks();
});

interface Side {
  readonly area: string;
  readonly vehicle: string;
  readonly vehicle2: string;
  readonly employee: string;
}

interface Fixture {
  readonly adminA: Browser;
  readonly editorA: Browser;
  readonly viewerA: Browser;
  readonly adminB: Browser;
  readonly a: Side;
  readonly b: Side;
}

let serial = 0;

async function side(browser: Browser): Promise<Side> {
  const area = await browser.post('/api/areas', { json: { name: 'Flota' } });
  const vehicle = async (): Promise<string> => {
    serial += 1;
    const reply = await browser.post('/api/vehicles', {
      json: {
        economicNumber: `U-${serial}`,
        plate: `ABC${serial}`,
        vin: null,
        make: 'Toyota',
        model: 'Hilux',
        year: 2022,
        areaId: area.json.id,
        odometerKm: 10,
      },
    });
    if (reply.status !== 201) throw new Error('vehicle fixture failed');
    return reply.json.id as string;
  };
  serial += 1;
  const employee = await browser.post('/api/employees', {
    json: {
      kind: 'driver',
      firstName: 'Ana',
      lastName: 'Perez',
      areaId: area.json.id,
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
  if (employee.status !== 201) throw new Error('employee fixture failed');
  return {
    area: area.json.id as string,
    vehicle: await vehicle(),
    vehicle2: await vehicle(),
    employee: employee.json.id as string,
  };
}

async function fixture(): Promise<Fixture> {
  world = createBffWorld();
  await world.tenant('Empresa Alfa', 'subject-admin-a');
  await world.tenant('Empresa Beta', 'subject-admin-b');
  await world.member('subject-admin-a', 'editor', 'subject-editor-a');
  await world.member('subject-admin-a', 'viewer', 'subject-viewer-a');
  const adminA = await world.loginAs('subject-admin-a');
  const adminB = await world.loginAs('subject-admin-b');
  return {
    adminA,
    adminB,
    editorA: await world.loginAs('subject-editor-a'),
    viewerA: await world.loginAs('subject-viewer-a'),
    a: await side(adminA),
    b: await side(adminB),
  };
}

const P = '/api/alerts';
const S = '/api/alerts/settings';

const document = async (
  browser: Browser,
  ownerId: string,
  expiresOn: string,
  over: Record<string, unknown> = {},
) => {
  const reply = await browser.post('/api/documents', {
    json: {
      ownerType: 'vehicle',
      ownerId,
      typeCode: 'registration_card',
      title: 'Tarjeta de circulación',
      expiresOn,
      ...over,
    },
  });
  if (reply.status !== 201) throw new Error(`document fixture failed: ${reply.status}`);
  return reply.json as { id: string; version: number };
};

const policy = async (browser: Browser, vehicleId: string, endsOn: string, number = 'pol-001') => {
  const reply = await browser.post('/api/insurance-policies', {
    json: {
      vehicleId,
      insurer: 'Aseguradora Ficticia',
      policyNumber: number,
      coverageType: 'comprehensive',
      startsOn: '2025-01-01',
      endsOn,
    },
  });
  if (reply.status !== 201) throw new Error(`policy fixture failed: ${reply.status}`);
  return reply.json as { id: string; version: number };
};

const subjects = (reply: Reply): string[] =>
  reply.json.items.map((alert: { subjectId: string }) => alert.subjectId);
const withoutId = (reply: Reply) => ({ ...reply.json, correlationId: '' });

describe('contract', () => {
  it('declares the same sources, severities and recipient roles as the domain', () => {
    expect([...BFF_ALERT_SOURCES]).toEqual([...ALERT_SOURCES]);
    expect([...BFF_ALERT_SEVERITIES]).toEqual([...ALERT_SEVERITIES]);
    expect([...BFF_ALERT_RECIPIENT_ROLES]).toEqual([...ALERT_RECIPIENT_ROLES]);
  });
  it('lists every role template of the composition as a possible recipient', () => {
    expect(Object.keys(ROLE_PERMISSIONS).sort()).toEqual([...ALERT_RECIPIENT_ROLES].sort());
  });
  it('protects every alert route: reads need a session, the write also the CSRF token', () => {
    const routes = Object.entries(BFF_ROUTES).filter(([id]) => id.startsWith('alerts.'));
    expect(routes.map(([id]) => id).sort()).toEqual([
      'alerts.list',
      'alerts.settings.get',
      'alerts.settings.update',
    ]);
    for (const [id, definition] of routes)
      expect([id, definition.kind]).toEqual([
        id,
        definition.method === 'GET' ? 'session' : 'session-csrf',
      ]);
  });
});

describe('alerts over HTTP', () => {
  it('derives expiring and expired alerts of the company, soonest first, with the day boundaries', async () => {
    const { adminA, adminB, a, b } = await fixture();
    const today = await document(adminA, a.vehicle, '2026-10-06');
    const thirty = await document(adminA, a.vehicle2, '2026-11-05');
    await document(adminA, a.vehicle, '2026-11-06', { typeCode: 'technical_inspection' });
    const expired = await document(adminA, a.vehicle2, '2026-10-05', {
      typeCode: 'transport_permit',
    });
    await document(adminA, a.vehicle, '2026-10-10', {
      ownerType: 'employee',
      ownerId: a.employee,
      typeCode: 'medical_exam',
    });
    const archived = await document(adminA, a.vehicle, '2026-10-08', {
      typeCode: 'municipal_authorization',
    });
    await adminA.post(`/api/documents/${archived.id}/archive`, { json: { version: 1 } });
    const none = await document(adminA, a.vehicle, '2026-10-07', { typeCode: 'ownership_title' });
    await adminA.post(`/api/documents/${none.id}/renew`, { json: { version: 1 } });
    const soon = await policy(adminA, a.vehicle, '2026-10-20');
    const ended = await policy(adminA, a.vehicle2, '2026-09-01', 'pol-002');
    await document(adminB, b.vehicle, '2026-10-07');

    const reply = await adminA.get(P);
    expect(reply.status).toBe(200);
    expect(reply.headers['cache-control']).toBe('no-store');
    expect(reply.json).toMatchObject({
      asOf: '2026-10-06',
      windowDays: 30,
      total: 5,
      nextCursor: null,
      sort: { field: 'dueOn', direction: 'asc' },
    });
    expect(subjects(reply)).toEqual([ended.id, expired.id, today.id, soon.id, thirty.id]);
    expect(reply.json.items[0]).toEqual({
      key: `insurance_policy:${ended.id}:2026-09-01`,
      source: 'insurance_policy',
      subjectId: ended.id,
      vehicleId: a.vehicle2,
      typeCode: 'comprehensive',
      dueOn: '2026-09-01',
      daysToExpiry: -35,
      severity: 'expired',
    });
    expect(reply.json.items.map((alert: { daysToExpiry: number }) => alert.daysToExpiry)).toEqual([
      -35, -1, 0, 14, 30,
    ]);
    expect(JSON.stringify(reply.json)).not.toMatch(/tenant|pol-00|Aseguradora|Tarjeta/i);

    // Filters.
    expect(subjects(await adminA.get(`${P}?source=insurance_policy`))).toEqual([ended.id, soon.id]);
    expect(subjects(await adminA.get(`${P}?severity=expired`))).toEqual([ended.id, expired.id]);
    expect(subjects(await adminA.get(`${P}?severity=expiring&vehicleId=${a.vehicle}`))).toEqual([
      today.id,
      soon.id,
    ]);
    expect((await adminB.get(P)).json.total).toBe(1);

    // The inclusive last day: after midnight UTC "today" is expired, and 'thirty' is 29 days away.
    // Twelve hours later (past midnight UTC); the old session has expired, so sign in again.
    world.advance(12 * 3_600_000 + 1_000);
    const next = await (await world.loginAs('subject-admin-a')).get(P);
    expect(next.json.asOf).toBe('2026-10-07');
    expect(
      next.json.items.find((alert: { subjectId: string }) => alert.subjectId === today.id),
    ).toMatchObject({
      daysToExpiry: -1,
      severity: 'expired',
    });
    expect(next.json.total).toBe(6);
  });

  it('restarts the cycle on renewal: a new key, and nothing once the new date is out of the window', async () => {
    const { adminA, a } = await fixture();
    const doc = await document(adminA, a.vehicle, '2026-10-10');
    const before = (await adminA.get(P)).json.items[0].key as string;
    const renewed = await adminA.post(`/api/documents/${doc.id}/renew`, {
      json: { version: 1, expiresOn: '2026-10-20' },
    });
    expect(renewed.status).toBe(200);
    const after = (await adminA.get(P)).json.items[0].key as string;
    expect(after).not.toBe(before);
    expect(after).toBe(`vehicle_document:${doc.id}:2026-10-20`);
    await adminA.post(`/api/documents/${doc.id}/renew`, {
      json: { version: 2, expiresOn: '2027-10-20' },
    });
    expect((await adminA.get(P)).json).toMatchObject({ items: [], total: 0 });
  });

  it('pages with signed cursors bound to the tenant and the filters', async () => {
    const { adminA, adminB, a } = await fixture();
    for (let n = 0; n < 27; n += 1)
      await document(
        adminA,
        n % 2 === 0 ? a.vehicle : a.vehicle2,
        `2026-10-${String(7 + (n % 20)).padStart(2, '0')}`,
      );
    const page1 = await adminA.get(P);
    expect(page1.json.items).toHaveLength(25);
    expect(page1.json.total).toBe(27);
    const cursor = page1.json.nextCursor as string;
    const page2 = await adminA.get(`${P}?cursor=${encodeURIComponent(cursor)}`);
    expect(page2.json.items).toHaveLength(2);
    expect(page2.json.nextCursor).toBeNull();
    expect(new Set([...subjects(page1), ...subjects(page2)]).size).toBe(27);
    for (const path of [
      `${P}?cursor=${encodeURIComponent(cursor)}&severity=expired`,
      `${P}?cursor=${encodeURIComponent(cursor)}&limit=50`,
      `${P}?cursor=${encodeURIComponent(cursor)}&source=vehicle_document`,
      `${P}?cursor=${encodeURIComponent(cursor)}&vehicleId=${a.vehicle}`,
      `${P}?cursor=${encodeURIComponent(`${cursor}x`)}`,
      `${P}?cursor=garbage`,
    ])
      expect((await adminA.get(path)).status, path).toBe(400);
    expect((await adminB.get(`${P}?cursor=${encodeURIComponent(cursor)}`)).status).toBe(400);
  });

  it('issues no cursor beyond the deepest offset the derivation supports', async () => {
    const { adminA, a } = await fixture();
    await document(adminA, a.vehicle, '2026-10-07');
    const spy = vi.spyOn(world.platform.alerts, 'list').mockResolvedValue({
      ok: true,
      value: { tenantId: 'x', items: [], total: 100_000, asOf: '2026-10-06', windowDays: 30 },
    });
    expect((await adminA.get(`${P}?limit=100`)).json.nextCursor).toEqual(expect.any(String));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('rejects bad queries and unsupported methods', async () => {
    const { adminA } = await fixture();
    for (const query of [
      '?source=employee_document',
      '?severity=valid',
      '?vehicleId=bad id',
      '?limit=7',
      '?offset=1',
      '?unknown=1',
      '?severity=expired&severity=expiring',
    ])
      expect((await adminA.get(`${P}${query}`)).status, query).toBe(400);
    expect((await adminA.send('POST', P, { json: {} })).status).toBe(405);
    expect((await adminA.send('DELETE', P)).status).toBe(405);
  });
});

describe('alert settings over HTTP', () => {
  const full = (over: Record<string, unknown> = {}) => ({
    version: 0,
    expiryWindowDays: 7,
    recipientRoles: ['editor', 'admin'],
    ...over,
  });

  it('reads the defaults at version 0, saves, narrows the window of the alerts and bumps the version', async () => {
    const { adminA, a } = await fixture();
    await document(adminA, a.vehicle, '2026-10-10');
    await document(adminA, a.vehicle2, '2026-10-30', { typeCode: 'technical_inspection' });
    const defaults = await adminA.get(S);
    expect(defaults.status).toBe(200);
    expect(defaults.json).toEqual({
      expiryWindowDays: 30,
      recipientRoles: [...DEFAULT_RECIPIENT_ROLES],
      version: 0,
      updatedBy: null,
      updatedAt: null,
    });
    expect((await adminA.get(P)).json.total).toBe(2);
    const saved = await adminA.send('PUT', S, { json: full() });
    expect(saved.status).toBe(200);
    expect(saved.json).toMatchObject({
      expiryWindowDays: 7,
      recipientRoles: ['admin', 'editor'],
      version: 1,
      updatedBy: expect.stringMatching(/^user-/),
      updatedAt: '2026-10-06T12:00:00.000Z',
    });
    expect(saved.json).not.toHaveProperty('tenantId');
    expect((await adminA.get(S)).json).toEqual(saved.json);
    expect((await adminA.get(P)).json).toMatchObject({ total: 1, windowDays: 7 });
    const again = await adminA.send('PUT', S, { json: full({ version: 1, expiryWindowDays: 30 }) });
    expect(again.json).toMatchObject({ version: 2, expiryWindowDays: 30 });
    expect((await adminA.get(P)).json.total).toBe(2);
  });

  it('answers 409 stale_version for an old version and 400 for malformed bodies, changing nothing', async () => {
    const { adminA } = await fixture();
    await adminA.send('PUT', S, { json: full() });
    for (const version of [0, 7]) {
      const stale = await adminA.send('PUT', S, { json: full({ version }) });
      expect(stale.status).toBe(409);
      expect(stale.json.code).toBe('stale_version');
    }
    for (const json of [
      {},
      { version: 1 },
      full({ tenantId: 'other' }),
      full({ version: -1 }),
      full({ version: '1' }),
      full({ expiryWindowDays: 0 }),
      full({ expiryWindowDays: 31 }),
      full({ expiryWindowDays: 1.5 }),
      full({ recipientRoles: [] }),
      full({ recipientRoles: ['root'] }),
      full({ recipientRoles: ['admin', 'admin'] }),
      full({ recipientRoles: 'admin' }),
    ])
      expect((await adminA.send('PUT', S, { json })).status, JSON.stringify(json)).toBe(400);
    expect((await adminA.get(S)).json).toMatchObject({ version: 1, expiryWindowDays: 7 });
    expect((await adminA.send('POST', S, { json: full() })).status).toBe(405);
    expect((await adminA.send('DELETE', S)).status).toBe(405);
  });

  it('lets every role read but only the configuration permission write', async () => {
    const { adminA, editorA, viewerA } = await fixture();
    const anonymous = world.browser();
    await world.prepare(anonymous);
    expect((await anonymous.get(S)).status).toBe(401);
    expect((await anonymous.get(P)).status).toBe(401);
    expect((await anonymous.send('PUT', S, { json: full() })).status).toBe(401);
    for (const browser of [editorA, viewerA]) {
      expect((await browser.get(S)).status).toBe(200);
      expect((await browser.get(P)).status).toBe(200);
      const denied = await browser.send('PUT', S, { json: full() });
      expect(denied.status).toBe(403);
      expect(denied.json).toMatchObject({ code: 'forbidden', message: 'Permission denied' });
    }
    expect((await adminA.get(S)).json.version).toBe(0);
  });

  it('requires the CSRF token on the write', async () => {
    const { adminA } = await fixture();
    for (const csrf of [null, '', 'forged']) {
      const reply = await adminA.send('PUT', S, { json: full(), csrf });
      expect(reply.status, String(csrf)).toBe(403);
      expect(reply.json.code).toBe('csrf_failed');
    }
    expect((await adminA.get(S)).json.version).toBe(0);
  });

  it('keeps each company settings apart', async () => {
    const { adminA, adminB, a } = await fixture();
    await document(adminA, a.vehicle, '2026-10-10');
    await adminA.send('PUT', S, { json: full({ expiryWindowDays: 2 }) });
    expect((await adminB.get(S)).json).toMatchObject({ version: 0, expiryWindowDays: 30 });
    // Version 1 for company B, which never saved, is as stale as for any unknown row.
    const stale = await adminB.send('PUT', S, { json: full({ version: 1 }) });
    expect(stale.status).toBe(409);
    expect(
      (await adminB.send('PUT', S, { json: full({ expiryWindowDays: 9 }) })).json.version,
    ).toBe(1);
    expect((await adminA.get(S)).json.expiryWindowDays).toBe(2);
    expect(withoutId(await adminB.get(P))).toMatchObject({ windowDays: 9, total: 0 });
  });
});
