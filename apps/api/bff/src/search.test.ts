import { afterEach, describe, expect, it } from 'vitest';
import { BFF_ROUTES, bffPath, bffRouteIds } from '../../../../packages/contracts/src/index.js';
import { createBffWorld, type BffWorld } from './test-support.js';

let world: BffWorld;
afterEach(() => world?.dispose());

const P = '/api/v1/search';

async function fixture() {
  world = createBffWorld();
  const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
  const b = await world.tenant('Empresa Beta', 'subject-admin-b');
  await world.member('subject-admin-a', 'pii_reader', 'subject-pii-a');
  const adminA = await world.loginAs('subject-admin-a');
  const adminB = await world.loginAs('subject-admin-b');
  const piiA = await world.loginAs('subject-pii-a');
  const vehicles = [];
  for (const [admin, tag] of [
    [adminA, 'a'],
    [adminB, 'b'],
  ] as const) {
    const area = await admin.post('/api/areas', { json: { name: 'Taller' } });
    const vehicle = await admin.post('/api/vehicles', {
      json: {
        economicNumber: 'S-001',
        plate: 'SRC-001',
        make: 'Nissan',
        model: `NP300 ${tag}`,
        year: 2023,
        areaId: area.json.id,
        odometerKm: 5000,
      },
    });
    expect(vehicle.status, vehicle.text).toBe(201);
    vehicles.push(vehicle.json.id as string);
  }
  const reconcile = async () => {
    world.advance(61_000);
    for (const tenant of [a.tenantId, b.tenantId])
      await world.platform.search.enqueueReconcile(tenant);
    await world.platform.runtime.drainOutbox();
  };
  return { a, b, adminA, adminB, piiA, vehicles, reconcile };
}

describe('GET /api/v1/search', () => {
  it('is a session route of the contract', () => {
    expect(bffRouteIds).toContain('search.query');
    expect(BFF_ROUTES['search.query']).toMatchObject({
      method: 'GET',
      kind: 'session',
      status: 200,
    });
    expect(bffPath('search.query', {}, { q: 'ABC 1', types: 'vehicle,driver' })).toBe(
      '/api/v1/search?q=ABC+1&types=vehicle%2Cdriver',
    );
  });

  it('needs a session', async () => {
    const f = await fixture();
    const anonymous = await world.browser().get(`${P}?q=src`);
    expect(anonymous.status).toBe(401);
    expect(f.vehicles).toHaveLength(2);
  });

  it('answers the groups of the reader, scoped to their company, with the link of each hit', async () => {
    const f = await fixture();
    await f.reconcile();
    const answer = await f.adminA.get(`${P}?q=src-001`);
    expect(answer.status, answer.text).toBe(200);
    const vehicle = answer.json.groups.find((g: { type: string }) => g.type === 'vehicle');
    expect(vehicle).toEqual({
      type: 'vehicle',
      total: 1,
      items: [
        {
          id: f.vehicles[0],
          label: expect.stringContaining('SRC-001'),
          href: `/flota/vehiculos/${f.vehicles[0]}`,
        },
      ],
    });
    const other = await f.adminB.get(`${P}?q=SRC%20001`);
    expect(other.json.groups[0].items[0].id).toBe(f.vehicles[1]);
    // A reader without incidents:view gets no incident group at all.
    const pii = await f.piiA.get(`${P}?q=src`);
    expect(pii.json.groups.map((g: { type: string }) => g.type)).not.toContain('incident');
  });

  it('restricts the types asked for', async () => {
    const f = await fixture();
    await f.reconcile();
    const answer = await f.adminA.get(`${P}?q=src&types=vehicle,policy`);
    expect(answer.json.groups.map((g: { type: string }) => g.type)).toEqual(['vehicle', 'policy']);
  });

  it('rejects anything but a strict query with a uniform 400', async () => {
    const f = await fixture();
    const bad = [
      '',
      '?q=',
      '?q=%20',
      `?q=${'a'.repeat(65)}`,
      '?q=a&q=b',
      '?q=a&types=nope',
      '?q=a&types=vehicle,vehicle',
      '?q=a&types=vehicle,',
      '?q=a&limit=5',
      '?types=vehicle',
      '?q=a&tenantId=x',
    ];
    for (const query of bad) {
      const answer = await f.adminA.get(`${P}${query}`);
      expect(answer.status, query).toBe(400);
      expect(answer.json.code).toBe('bad_request');
      expect(answer.text).not.toContain('aaaa');
    }
  });

  it('does not echo what was typed in an error', async () => {
    const f = await fixture();
    const answer = await f.adminA.get(`${P}?q=secret-term&types=nope`);
    expect(answer.status).toBe(400);
    expect(answer.text).not.toContain('secret-term');
  });
});
