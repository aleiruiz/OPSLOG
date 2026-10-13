import { afterEach, describe, expect, it } from 'vitest';
import { BFF_ROUTES, bffRouteIds } from '../../../../packages/contracts/src/index.js';
import { createBffWorld, type BffWorld } from './test-support.js';

let world: BffWorld;
afterEach(() => world?.dispose());

const P = '/api/v1/incidents';
const DAY = 86_400_000;
let keys = 0;
const key = () => `key-sla-${(keys += 1)}-bff-test`;

async function fixture() {
  world = createBffWorld();
  const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
  await world.tenant('Empresa Beta', 'subject-admin-b');
  const manager = await world.member('subject-admin-a', 'incident_manager', 'subject-manager-a');
  await world.member('subject-admin-a', 'viewer', 'subject-viewer-a');
  const mech = await world.member('subject-admin-a', 'incident_manager', 'subject-mech-a');
  const adminA = await world.loginAs('subject-admin-a');
  const managerA = await world.loginAs('subject-manager-a');
  const viewerA = await world.loginAs('subject-viewer-a');
  const mechA = await world.loginAs('subject-mech-a');
  const adminB = await world.loginAs('subject-admin-b');
  const area = await adminA.post('/api/areas', { json: { name: 'Taller' } });
  const vehicle = await adminA.post('/api/vehicles', {
    json: {
      economicNumber: 'S-001',
      plate: 'SLA-001',
      make: 'Nissan',
      model: 'NP300',
      year: 2023,
      areaId: area.json.id,
      odometerKm: 5000,
    },
  });
  const workshop = await adminA.post('/api/v1/maintenance/workshops', {
    json: { name: 'Taller Uno', specialties: ['frenos'] },
  });
  await adminA.post('/api/v1/maintenance/mechanics', {
    json: {
      name: 'Mecánico Interno',
      specialties: ['frenos'],
      kind: 'internal',
      workshopId: workshop.json.id,
      memberId: mech.identityId,
    },
  });
  const go = (id: string, json: Record<string, unknown>) =>
    managerA.post(`${P}/${id}/transitions`, { json, headers: { 'idempotency-key': key() } });
  /** A critical case reported and assigned to the manager: its target is 7 days. */
  const reported = async (severity = 'critical') => {
    const created = await managerA.post(P, {
      json: {
        vehicleId: vehicle.json.id,
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
    const done = await go(created.json.id, { command: 'report', version: created.json.version });
    const assigned = await go(created.json.id, {
      command: 'assign',
      version: done.json.version,
      responsibleId: manager.identityId,
    });
    expect(assigned.status, assigned.text).toBe(200);
    return created.json.id as string;
  };
  const who = { adminA, adminB, managerA, viewerA, mechA };
  /** Time passes: sessions idle out, so everyone signs in again, and the SLA scan runs. */
  const later = async (days: number) => {
    world.advance(days * DAY);
    who.adminA = await world.loginAs('subject-admin-a');
    who.adminB = await world.loginAs('subject-admin-b');
    who.managerA = await world.loginAs('subject-manager-a');
    who.viewerA = await world.loginAs('subject-viewer-a');
    who.mechA = await world.loginAs('subject-mech-a');
    await world.platform.incidentSlaModule.scanner.scan(a.tenantId);
  };
  return { a, who, reported, later };
}

describe('GET /api/v1/incidents/alerts', () => {
  it('is a contract route declared before the incident id, and the literal segment is not an id', async () => {
    const { who } = await fixture();
    const managerA = who.managerA;
    expect(bffRouteIds).toContain('incidents.alerts.list');
    expect(BFF_ROUTES['incidents.alerts.list'].path.join('/')).toBe('api/v1/incidents/alerts');
    const answer = await managerA.get(`${P}/alerts`);
    expect(answer.status, answer.text).toBe(200);
    expect(answer.json).toEqual({ items: [], total: 0 });
  });

  it('shows the SLA block on the detail and the list, and each member the notices their rights allow (acceptance 1, 2, 3)', async () => {
    const { who, reported, later } = await fixture();
    const managerA = who.managerA;
    const id = await reported();
    const fresh = await managerA.get(`${P}/${id}`);
    expect(fresh.json.sla).toMatchObject({
      cycle: 1,
      state: 'on_track',
      targetDays: 7,
      elapsedPercent: 0,
      previousCycles: [],
    });
    await later(6);
    const detail = await who.managerA.get(`${P}/${id}`);
    expect(detail.json.sla).toMatchObject({ state: 'warning', targetDays: 7 });
    const list = await who.managerA.get(P);
    expect(list.json.items[0].sla).toMatchObject({ state: 'warning' });
    const mine = await who.managerA.get(`${P}/alerts`);
    expect(mine.status).toBe(200);
    const kinds = (mine.json.items as { kind: string }[]).map((item) => item.kind).sort();
    expect(kinds).toEqual(['inactive', 'sla_warning']);
    const warning = (mine.json.items as { kind: string }[]).find((i) => i.kind === 'sla_warning');
    expect(warning).toEqual({
      id: expect.any(String),
      incidentId: id,
      folio: expect.stringMatching(/^SIN-/),
      kind: 'sla_warning',
      cycle: 1,
      createdAt: expect.any(String),
      severity: 'critical',
      deadline: expect.any(String),
    });
    // The administrator is not the responsible: nothing of the warning, but the breach reaches them.
    expect((await who.adminA.get(`${P}/alerts`)).json.total).toBe(0);
    await later(2);
    const admin = await who.adminA.get(`${P}/alerts`);
    expect((admin.json.items as { kind: string }[]).map((i) => i.kind)).toContain('sla_breach');
    // A member who may only view cases sees no notice.
    expect((await who.viewerA.get(`${P}/alerts`)).json).toEqual({ items: [], total: 0 });
    // No amount, name or free text travels in a notice.
    expect(JSON.stringify(admin.json)).not.toMatch(/amount|description|Calle|displayName/i);
  });

  it('filters by kind and case, pages 25/50/100, and refuses bad queries naming the field only', async () => {
    const { who, reported, later } = await fixture();
    const first = await reported();
    await reported('high');
    await later(6);
    const managerA = who.managerA;
    const all = await managerA.get(`${P}/alerts?limit=100`);
    expect(all.json.total).toBeGreaterThanOrEqual(3);
    const byKind = await managerA.get(`${P}/alerts?kind=sla_warning`);
    expect((byKind.json.items as { kind: string }[]).every((i) => i.kind === 'sla_warning')).toBe(
      true,
    );
    const byCase = await managerA.get(`${P}/alerts?incidentId=${first}`);
    expect(
      (byCase.json.items as { incidentId: string }[]).every((i) => i.incidentId === first),
    ).toBe(true);
    const page = await managerA.get(`${P}/alerts?limit=25&offset=1`);
    expect(page.json.items).toHaveLength(all.json.total - 1);
    for (const query of [
      'limit=10',
      'kind=other',
      'offset=-1',
      'offset=x',
      'nope=1',
      'incidentId=%20',
    ]) {
      const bad = await managerA.get(`${P}/alerts?${query}`);
      expect(bad.status, query).toBe(400);
      expect(JSON.stringify(bad.json)).not.toContain('other"');
    }
    expect((await managerA.get(`${P}/alerts?kind=sla_warning&kind=sla_breach`)).status).toBe(400);
  });

  it('needs a session, isolates tenants and gives a mechanic-linked member nothing (acceptance 12)', async () => {
    const { who, reported, later } = await fixture();
    const id = await reported();
    await later(6);
    expect((await who.managerA.get(`${P}/alerts`)).json.total).toBeGreaterThan(0);
    expect((await who.adminB.get(`${P}/alerts`)).json).toEqual({ items: [], total: 0 });
    expect((await who.adminB.get(`${P}/alerts?incidentId=${id}`)).json).toEqual({
      items: [],
      total: 0,
    });
    expect((await who.mechA.get(`${P}/alerts`)).json).toEqual({ items: [], total: 0 });
    const anonymous = world.browser();
    expect((await anonymous.get(`${P}/alerts`)).status).toBe(401);
  });
});
