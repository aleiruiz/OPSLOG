import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BffDashboard, BffDashboardWidget } from '../../../packages/contracts/src/index.js';
import { adminUrl } from '../fleet/mysql.js';
import { API, startMvpWorld, tick, type MvpWorld } from './world.js';

/**
 * Journey «dashboard → drill-down» over two real MySQL databases and the HTTP surface (MVP-INTEGRATE,
 * alcance 3): the figure of a widget equals the rows of the list its drill-down names, a reader sees only
 * the indicators their permissions allow, and company B's figures are its own. Synthetic data only.
 */
const suite = adminUrl ? describe : describe.skip;

type Browser = MvpWorld['adminA'];

suite('Journey: dashboard → drill-down', { timeout: 180_000 }, () => {
  let w: MvpWorld;
  const ids: string[] = [];
  beforeAll(async () => {
    w = await startMvpWorld();
    const area = await w.area(w.adminA, 'Flota tablero');
    for (const tag of ['DD1', 'DD2', 'DD3', 'DD4']) ids.push(await w.vehicle(w.adminA, area, tag));
    // One in maintenance and one out of service: the «fuera de servicio» widget counts both.
    for (const [index, status] of [
      [1, 'in_maintenance'],
      [2, 'out_of_service'],
    ] as const) {
      const id = ids[index] as string;
      const current = await w.adminA.get(`/api/vehicles/${id}`);
      const moved = await w.adminA.post(`/api/vehicles/${id}/status`, {
        json: { version: current.json.version, status, reason: 'Recorrido del tablero' },
      });
      expect(moved.status, moved.text).toBe(200);
    }
    await tick(w.platformA);
  }, 120_000);
  afterAll(async () => w?.stop(), 60_000);

  const dashboard = async (browser: Browser, query = ''): Promise<BffDashboard> => {
    const reply = await browser.get(`${API}/dashboard${query}`);
    expect(reply.status, reply.text).toBe(200);
    return reply.json as BffDashboard;
  };
  const widget = (board: BffDashboard, id: string): BffDashboardWidget | undefined =>
    board.widgets.find((item) => item.id === id);
  const countOf = (board: BffDashboard, id: string): number => {
    const found = widget(board, id);
    if (found?.kind !== 'count') throw new Error(`${id} is not a count widget`);
    return found.value;
  };
  /** The vehicles list the drill-down names, one request per status it lists. */
  const listed = async (browser: Browser, statuses: string): Promise<number> => {
    let total = 0;
    for (const status of statuses.split(',')) {
      const reply = await browser.get(`/api/vehicles?status=${status}&limit=100`);
      expect(reply.status, reply.text).toBe(200);
      total += reply.json.items.length;
    }
    return total;
  };

  it('counts the vehicles that its drill-down list shows', async () => {
    const board = await dashboard(w.adminA);
    const active = widget(board, 'vehicles_active');
    const down = widget(board, 'vehicles_out_of_service');
    expect(active?.drilldown).toMatchObject({ target: 'vehicles', filters: { status: 'active' } });
    expect(countOf(board, 'vehicles_active')).toBe(2);
    expect(await listed(w.adminA, active?.drilldown.filters['status'] as string)).toBe(2);
    expect(countOf(board, 'vehicles_out_of_service')).toBe(2);
    expect(await listed(w.adminA, down?.drilldown.filters['status'] as string)).toBe(2);
  });

  it('filters by area and keeps the formula of every figure in the payload', async () => {
    const area = await w.adminA.get('/api/areas');
    const areaId = area.json.items[0].id as string;
    const filtered = await dashboard(w.adminA, `?areaId=${areaId}`);
    expect(countOf(filtered, 'vehicles_active')).toBe(2);
    expect(widget(filtered, 'vehicles_active')?.drilldown.filters).toMatchObject({ areaId });
    for (const item of filtered.widgets) expect(item.definition.formula.length).toBeGreaterThan(10);
    // An area of company B is, for company A, an area that does not exist.
    const foreign = await w.area(w.adminB, 'Área ajena');
    const refused = await w.adminA.get(`${API}/dashboard?areaId=${foreign}`);
    expect(refused.status, refused.text).toBe(422);
  });

  it('shows each reader only the indicators their permissions allow', async () => {
    const names = async (browser: Browser) =>
      (await dashboard(browser)).widgets.map((item) => item.id);
    const admin = await names(w.adminA);
    expect(admin).toContain('maintenance_cost');
    expect(admin).toContain('incidents_open');
    const viewer = await names(w.viewerA);
    expect(viewer).toContain('vehicles_active');
    expect(viewer).not.toContain('maintenance_cost');
    const auditor = await names(w.auditorA);
    expect(auditor).toContain('vehicles_active');
    expect(auditor).not.toContain('incidents_open');
    expect(auditor).not.toContain('maintenance_cost');
    // An indicator the reader may not see is absent from the payload, with no count and no name.
    const raw = JSON.stringify((await dashboard(w.viewerA)).widgets);
    expect(raw).not.toContain('maintenance_cost');
    expect(raw).not.toMatch(/amountMinor/);
  });

  it('computes company B from its own database only', async () => {
    const own = await dashboard(w.adminB);
    expect(countOf(own, 'vehicles_active')).toBe(0);
    expect(countOf(own, 'vehicles_out_of_service')).toBe(0);
    expect(JSON.stringify(own)).not.toContain(ids[0] as string);
    expect((await w.viewerB.get(`/api/vehicles?status=active&limit=100`)).json.items).toEqual([]);
  });
});
