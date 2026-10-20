import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminUrl } from '../fleet/mysql.js';
import { API, drain, job, startMvpWorld, tick, type MvpWorld } from './world.js';

/**
 * Journey «búsqueda → detalle» over two real MySQL databases and the HTTP surface (MVP-INTEGRATE,
 * alcance 3): a record is created, the search projection follows it, the hit opens its detail, the
 * action is audited, and nothing of company A is found or opened from company B. Synthetic data only.
 */
const suite = adminUrl ? describe : describe.skip;

suite('Journey: búsqueda → detalle', { timeout: 180_000 }, () => {
  let w: MvpWorld;
  let vehicleId: string;
  let driverId: string;
  beforeAll(async () => {
    w = await startMvpWorld();
    const area = await w.area(w.adminA, 'Flota búsqueda');
    vehicleId = await w.vehicle(w.adminA, area, 'JS1');
    driverId = await w.driver(w.adminA, area, 'JS1');
    // The projection follows through the periodic reconcile and the outbox, as the api process does.
    await w.platformA.runtime.periodic.tick('search.reconcile');
    await drain(w.platformA);
    await job(w.platformA, 'outbox').run();
  }, 120_000);
  afterAll(async () => w?.stop(), 60_000);

  const search = async (browser: MvpWorld['adminA'], q: string) => {
    const reply = await browser.get(`${API}/search?q=${encodeURIComponent(q)}`);
    expect(reply.status, reply.text).toBe(200);
    return reply.json.groups as {
      type: string;
      total: number;
      items: { id: string; href: string }[];
    }[];
  };
  const idsOf = (groups: Awaited<ReturnType<typeof search>>, type: string) =>
    groups.find((group) => group.type === type)?.items.map((item) => item.id) ?? [];

  it('finds the vehicle by plate and opens its detail from the hit', async () => {
    const groups = await search(w.adminA, 'FLJS1');
    expect(idsOf(groups, 'vehicle')).toEqual([vehicleId]);
    const hit = groups.find((group) => group.type === 'vehicle')?.items[0];
    expect(hit?.href).toContain(vehicleId);
    const detail = await w.adminA.get(`/api/vehicles/${vehicleId}`);
    expect(detail.status, detail.text).toBe(200);
    expect(detail.json).toMatchObject({ id: vehicleId, plate: 'FLJS1' });
  });

  it('finds the driver by name and opens the record', async () => {
    const groups = await search(w.adminA, 'perez');
    expect(idsOf(groups, 'driver')).toContain(driverId);
    const detail = await w.adminA.get(`/api/employees/${driverId}`);
    expect(detail.status, detail.text).toBe(200);
  });

  it('matches personal data only exactly and only for who may see it', async () => {
    const found = await w.adminA.get(`/api/employees/${driverId}`);
    const license = found.json.pii?.licenseNumber as string | undefined;
    expect(license, 'the administrator reads the license in the detail').toBeTruthy();
    expect(idsOf(await search(w.piiA, license as string), 'driver')).toContain(driverId);
    expect(idsOf(await search(w.piiA, (license as string).slice(0, 4)), 'driver')).not.toContain(
      driverId,
    );
    expect(idsOf(await search(w.viewerA, license as string), 'driver')).not.toContain(driverId);
    expect(idsOf(await search(w.viewerB, license as string), 'driver')).toEqual([]);
  });

  it('leaves the creation in the audit trail of the record, readable by the auditor only', async () => {
    await tick(w.platformA);
    const trail = await w.auditorA.get(`${API}/audit/entities/vehicle/${vehicleId}`);
    expect(trail.status, trail.text).toBe(200);
    expect(trail.json.items.length).toBeGreaterThan(0);
    expect(trail.json.items[0]).toMatchObject({ entityType: 'vehicle', entityId: vehicleId });
    expect((await w.viewerA.get(`${API}/audit/entities/vehicle/${vehicleId}`)).status).toBe(403);
  });

  it('shows nothing of company A to company B, in the search or in the detail', async () => {
    expect(idsOf(await search(w.viewerB, 'FLJS1'), 'vehicle')).toEqual([]);
    expect((await w.viewerB.get(`/api/vehicles/${vehicleId}`)).status).toBe(404);
    expect((await w.adminB.get(`/api/vehicles/${vehicleId}`)).status).toBe(404);
    const foreign = await w.adminB.get(`${API}/audit/entities/vehicle/${vehicleId}`);
    expect(foreign.status, foreign.text).toBe(200);
    expect(foreign.json.items).toEqual([]);
  });
});
