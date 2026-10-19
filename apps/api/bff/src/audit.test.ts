import { afterEach, describe, expect, it } from 'vitest';
import { BFF_ROUTES } from '../../../../packages/contracts/src/index.js';
import { createAuditEvent } from '../../../../packages/platform/audit/src/index.js';
import { createBffWorld, type BffWorld, type Browser } from './test-support.js';

let world: BffWorld;
afterEach(() => world?.dispose());

const P = '/api/v1/audit';
const VEHICLE = {
  economicNumber: 'A-001',
  plate: 'AUD-001',
  make: 'Nissan',
  model: 'NP300',
  year: 2023,
  odometerKm: 100,
};

async function fixture() {
  world = createBffWorld();
  const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
  const b = await world.tenant('Empresa Beta', 'subject-admin-b');
  const auditor = await world.member('subject-admin-a', 'auditor', 'subject-auditor-a');
  await world.member('subject-admin-a', 'editor', 'subject-editor-a');
  await world.member('subject-admin-a', 'viewer', 'subject-viewer-a');
  const manager = await world.member('subject-admin-a', 'incident_manager', 'subject-manager-a');
  const adminA = await world.loginAs('subject-admin-a');
  const auditorA = await world.loginAs('subject-auditor-a');
  const editorA = await world.loginAs('subject-editor-a');
  const viewerA = await world.loginAs('subject-viewer-a');
  const managerA = await world.loginAs('subject-manager-a');
  const adminB = await world.loginAs('subject-admin-b');
  const vehicleOf = async (browser: Browser, economicNumber: string) => {
    const area = await browser.post('/api/areas', { json: { name: `Flota ${economicNumber}` } });
    const vehicle = await browser.post('/api/vehicles', {
      json: { ...VEHICLE, economicNumber, plate: `P-${economicNumber}`, areaId: area.json.id },
    });
    expect(vehicle.status, vehicle.text).toBe(201);
    return vehicle.json.id as string;
  };
  const vehicleA = await vehicleOf(adminA, 'A-001');
  const vehicleB = await vehicleOf(adminB, 'B-001');
  return {
    a,
    b,
    auditor,
    manager,
    adminA,
    auditorA,
    editorA,
    viewerA,
    managerA,
    adminB,
    vehicleA,
    vehicleB,
  };
}

describe('audit contract', () => {
  it('declares the audit reads as session GETs under /api/v1/audit', () => {
    for (const id of ['audit.list', 'audit.entity', 'audit.reconciliation'] as const) {
      expect(BFF_ROUTES[id].method).toBe('GET');
      expect(BFF_ROUTES[id].kind).toBe('session');
      expect(BFF_ROUTES[id].path.slice(0, 3)).toEqual(['api', 'v1', 'audit']);
    }
  });
});

describe('audit over HTTP: permission', () => {
  it('needs view_audit for the listing, the entity history and the reconciliation', async () => {
    const { auditorA, adminA, editorA, viewerA, vehicleA } = await fixture();
    const paths = [P, `${P}/reconciliation`, `${P}/entities/vehicle/${vehicleA}`];
    for (const browser of [editorA, viewerA])
      for (const path of paths) expect((await browser.get(path)).status, path).toBe(403);
    for (const browser of [auditorA, adminA])
      for (const path of paths) expect((await browser.get(path)).status, path).toBe(200);
    const anonymous = world.browser();
    expect((await anonymous.get(P)).status).toBe(401);
  });

  it('needs the read permission of the record module on top of view_audit', async () => {
    const { auditorA, adminA, managerA, vehicleA } = await fixture();
    const created = await managerA.post('/api/v1/incidents', {
      json: { vehicleId: vehicleA, type: 'collision' },
    });
    expect(created.status, created.text).toBe(201);
    const path = `${P}/entities/incident/${created.json.id}`;
    expect((await auditorA.get(path)).status).toBe(403);
    expect((await adminA.get(path)).status).toBe(200);
    // The incident manager can read incidents but not the audit.
    expect((await managerA.get(path)).status).toBe(403);
    expect((await adminA.get(`${P}/entities/not_a_type/${vehicleA}`)).status).toBe(400);
  });
});

describe('audit over HTTP: content', () => {
  it('lists the company audit newest first with Spanish text and readable records', async () => {
    const { auditorA, vehicleA } = await fixture();
    const reply = await auditorA.get(P);
    expect(reply.status, reply.text).toBe(200);
    expect(reply.json.sort).toEqual({ field: 'occurredAt', direction: 'desc' });
    const created = reply.json.items.find(
      (item: { action: string; entityId: string }) =>
        item.action === 'vehicle.created' && item.entityId === vehicleA,
    );
    expect(created).toMatchObject({
      actionLabel: 'Vehículo creado',
      result: 'success',
      entityTypeLabel: 'Vehículo',
      entityLabel: 'A-001',
      entityAvailable: true,
      changes: null,
    });
    expect(created.actor.label).toBe('Administrador');
    expect(created.actor.alias).toMatch(/^U-[0-9A-F]{6}$/);
    const times = reply.json.items.map((item: { occurredAt: string }) => item.occurredAt);
    expect([...times].sort().reverse()).toEqual(times);
    expect(reply.text).not.toContain('B-001');
    expect(reply.json.total).toBe(reply.json.items.length);
  });

  it('narrows by entity, action prefix, actor and result', async () => {
    const { auditorA, vehicleA } = await fixture();
    const byEntity = await auditorA.get(`${P}?entityType=vehicle&entityId=${vehicleA}`);
    expect(byEntity.json.items.map((item: { action: string }) => item.action)).toEqual([
      'vehicle.created',
    ]);
    const byAction = await auditorA.get(`${P}?action=area.`);
    expect(byAction.json.items.length).toBeGreaterThan(0);
    expect(
      byAction.json.items.every((item: { action: string }) => item.action.startsWith('area.')),
    ).toBe(true);
    const actor = byEntity.json.items[0].actor.id as string;
    expect((await auditorA.get(`${P}?actorId=${actor}`)).json.total).toBeGreaterThan(0);
    expect((await auditorA.get(`${P}?actorId=user-someone-else`)).json.items).toEqual([]);
    expect((await auditorA.get(`${P}?result=denied`)).json.items).toEqual([]);
  });

  it('never shows another company, not even through its record ids', async () => {
    const { auditorA, adminA, adminB, vehicleA, vehicleB } = await fixture();
    const foreign = await auditorA.get(`${P}?entityType=vehicle&entityId=${vehicleB}`);
    expect(foreign.status).toBe(200);
    expect(foreign.json).toMatchObject({ items: [], total: 0, nextCursor: null });
    const entity = await adminA.get(`${P}/entities/vehicle/${vehicleB}`);
    expect(entity.json.items).toEqual([]);
    const own = await adminB.get(`${P}/entities/vehicle/${vehicleB}`);
    expect(own.json.items).toHaveLength(1);
    expect((await adminB.get(`${P}/entities/vehicle/${vehicleA}`)).json.items).toEqual([]);
  });

  it('marks a record that no longer exists as unavailable', async () => {
    const { auditorA, a } = await fixture();
    await world.platform.audit.append(
      createAuditEvent(
        { tenantId: a.tenantId, actorId: 'system', actorKind: 'system', correlationId: 'corr-x' },
        {
          eventId: 'evt-gone',
          action: 'vehicle.archived',
          entityType: 'vehicle',
          entityId: 'veh-borrado',
          occurredAt: new Date().toISOString(),
        },
      ),
    );
    const reply = await auditorA.get(`${P}?entityId=veh-borrado`);
    expect(reply.json.items[0]).toMatchObject({
      entityLabel: 'Registro no disponible',
      entityAvailable: false,
      actor: { label: 'Sistema', kind: 'system' },
    });
  });

  it('keeps names, contact data and ids of people out of the response', async () => {
    const { auditorA, adminA } = await fixture();
    const area = await adminA.post('/api/areas', { json: { name: 'Operaciones' } });
    const employee = await adminA.post('/api/employees', {
      json: {
        kind: 'driver',
        firstName: 'Ana',
        lastName: 'Perezosa',
        areaId: area.json.id,
        employeeNumber: 'E-77',
        idType: 'ine',
        nationalId: 'SYNTH-ID-7788-Q1',
        phone: '+525590001234',
        email: 'ana.perezosa@synthetic.example',
        licenseNumber: 'LIC-445566-1',
        licenseType: 'c',
        licenseExpiresOn: '2099-01-31',
      },
    });
    expect(employee.status, employee.text).toBe(201);
    const forAuditor = await auditorA.get(`${P}?entityType=employee`);
    expect(forAuditor.json.items[0]).toMatchObject({
      entityLabel: 'Persona de la plantilla',
      actionLabel: 'Empleado creado',
    });
    for (const reply of [forAuditor, await adminA.get(`${P}?entityType=employee`)])
      expect(reply.text).not.toMatch(
        /Ana|Perezosa|SYNTH-ID|5590001234|synthetic\.example|LIC-445566/,
      );
    const forAdmin = await adminA.get(`${P}?entityType=employee`);
    expect(forAdmin.json.items[0].entityLabel).toBe('Empleado E-77');
  });

  it('shows the field diff of an incident only to readers of incidents, without free text', async () => {
    const { adminA, auditorA, managerA, vehicleA, a, manager } = await fixture();
    const created = await managerA.post('/api/v1/incidents', {
      json: { vehicleId: vehicleA, type: 'collision', severity: 'low' },
    });
    const id = created.json.id as string;
    const edited = await managerA.send('PATCH', `/api/v1/incidents/${id}`, {
      json: { version: 1, severity: 'high', description: 'Cliente Juan Pérez, tel 5512345678' },
    });
    expect(edited.status, edited.text).toBe(200);
    const timeline = await managerA.get(`/api/v1/incidents/${id}/timeline`);
    const update = timeline.json.items.find(
      (entry: { command: string }) => entry.command === 'update',
    );
    // The in-memory incident store keeps its own audit; the durable one is exercised in the MySQL suite.
    await world.platform.audit.append(
      createAuditEvent(
        {
          tenantId: a.tenantId,
          actorId: `user-${manager.identityId}`,
          actorKind: 'user',
          correlationId: 'corr-inc',
        },
        {
          eventId: 'evt-inc-updated',
          action: 'incident.updated',
          entityType: 'incident',
          entityId: id,
          occurredAt: update.occurredAt,
        },
      ),
    );
    const path = `${P}/entities/incident/${id}`;
    const admin = await adminA.get(path);
    expect(admin.status, admin.text).toBe(200);
    const row = admin.json.items.find(
      (item: { eventId: string }) => item.eventId === 'evt-inc-updated',
    );
    expect(row.entityLabel).toMatch(/^Siniestro /);
    expect(row.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'severity',
          state: 'value',
          before: 'low',
          after: 'high',
        }),
        { field: 'description', label: 'Descripción', state: 'restricted' },
      ]),
    );
    expect(admin.text).not.toMatch(/Juan|5512345678/);
    // The auditor does not read incidents: the global listing shows the event, never its fields.
    const global = await auditorA.get(`${P}?entityType=incident`);
    expect(global.json.items[0].changes).toBeNull();
    expect(global.text).not.toMatch(/Juan|5512345678|severity/);
  });
});

describe('audit over HTTP: query rules', () => {
  it('rejects bad ranges, page sizes, filters and unknown or repeated keys with 400', async () => {
    const { auditorA } = await fixture();
    const bad = [
      '?limit=7',
      '?unknown=1',
      '?limit=25&limit=50',
      '?from=2026-01-01T00:00:00.000Z',
      '?to=2026-01-01T00:00:00.000Z',
      '?from=2026-02-01T00:00:00.000Z&to=2026-01-01T00:00:00.000Z',
      '?from=2026-01-01T00:00:00.000Z&to=2026-01-01T00:00:00.000Z',
      '?from=2025-01-01T00:00:00.000Z&to=2026-03-01T00:00:00.000Z',
      '?from=ayer&to=hoy',
      '?action=DROP',
      '?action=unknown_domain.',
      '?result=maybe',
      '?entityType=nope',
      '?actorId=x%27%20OR%201%3D1',
      '?cursor=abc.def',
    ];
    for (const query of bad) expect((await auditorA.get(`${P}${query}`)).status, query).toBe(400);
    expect((await auditorA.get(`${P}/reconciliation?from=2026-01-01T00:00:00.000Z`)).status).toBe(
      400,
    );
    expect((await auditorA.get(`${P}/reconciliation?x=1`)).status).toBe(400);
  });

  it('accepts a 366-day range and defaults to the last 30 days', async () => {
    const { auditorA } = await fixture();
    const ok = await auditorA.get(`${P}?from=2025-10-05T00:00:00.000Z&to=2026-10-06T00:00:00.000Z`);
    expect(ok.status, ok.text).toBe(200);
    const fallback = await auditorA.get(P);
    expect(Date.parse(fallback.json.to) - Date.parse(fallback.json.from)).toBe(30 * 86_400_000);
  });

  it('pages with a signed cursor bound to the company, the filters and the window', async () => {
    const { auditorA, adminA, adminB } = await fixture();
    for (let n = 0; n < 30; n += 1) {
      expect((await adminA.post('/api/areas', { json: { name: `Área ${n}` } })).status).toBe(201);
      expect((await adminB.post('/api/areas', { json: { name: `Zona ${n}` } })).status).toBe(201);
    }
    const first = await auditorA.get(`${P}?limit=25`);
    expect(first.json.items).toHaveLength(25);
    expect(first.json.total).toBeGreaterThan(25);
    expect(first.json.nextCursor).toEqual(expect.any(String));
    const seen = new Set<string>(first.json.items.map((item: { eventId: string }) => item.eventId));
    let cursor = first.json.nextCursor as string | null;
    for (let guard = 0; cursor && guard < 10; guard += 1) {
      const page = await auditorA.get(`${P}?limit=25&cursor=${encodeURIComponent(cursor)}`);
      expect(page.status, page.text).toBe(200);
      for (const item of page.json.items as { eventId: string }[]) {
        expect(seen.has(item.eventId)).toBe(false);
        seen.add(item.eventId);
      }
      expect(page.json.from).toBe(first.json.from);
      cursor = page.json.nextCursor;
    }
    expect(seen.size).toBe(first.json.total);
    // Reused by company B, with other filters or another page size: refused, never rows of A.
    const stolen = await adminB.get(
      `${P}?limit=25&cursor=${encodeURIComponent(first.json.nextCursor)}`,
    );
    expect(stolen.status).toBe(400);
    expect(stolen.text).not.toContain('Área');
    const cursorParam = encodeURIComponent(first.json.nextCursor);
    expect((await auditorA.get(`${P}?limit=50&cursor=${cursorParam}`)).status).toBe(400);
    expect((await auditorA.get(`${P}?limit=25&action=area.&cursor=${cursorParam}`)).status).toBe(
      400,
    );
  });
});

describe('audit over HTTP: reconciliation', () => {
  it('reports the local audit as fully relayed on the in-memory store', async () => {
    const { auditorA } = await fixture();
    const reply = await auditorA.get(`${P}/reconciliation`);
    expect(reply.status, reply.text).toBe(200);
    expect(reply.json).toMatchObject({
      pendingTotal: 0,
      pending: [],
      oldestPendingAgeSeconds: null,
    });
    expect(reply.json.local).toBe(reply.json.relayed);
    expect(reply.json.local).toBeGreaterThan(0);
  });
});
