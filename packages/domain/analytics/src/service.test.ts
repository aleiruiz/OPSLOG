import { describe, expect, it } from 'vitest';
import type { Permission } from '../../identity/src/index.js';
import { companyFixture } from './fixture.js';
import { WIDGETS } from './catalog.js';
import { DashboardService } from './service.js';
import { emptyFixture, fixtureSources, NOW, TENANT, ZONE, type Fixture } from './test-support.js';
import {
  AnalyticsError,
  type CountWidget,
  type DashboardWidget,
  type RatioWidget,
  type WidgetId,
} from './types.js';

const ALL: readonly Permission[] = ['view', 'view_costs', 'incidents:view'];
const RANGE = { from: '2026-10-17', to: '2026-10-19' };

function setup(fixture: Fixture) {
  const { sources, calls } = fixtureSources(fixture);
  const service = new DashboardService(sources, { now: () => NOW });
  const run = async (granted: readonly Permission[] = ALL, query: object = RANGE) =>
    service.compute(TENANT, await service.resolve(TENANT, query), granted);
  return { calls, service, run };
}

const widgetOf = <T extends DashboardWidget>(
  widgets: readonly DashboardWidget[],
  id: WidgetId,
): T => widgets.find((widget) => widget.id === id) as T;

describe('the formulas on a company worked out by hand', () => {
  it('counts the vehicles, drivers, plans and expiries of today', async () => {
    const { widgets } = await setup(companyFixture()).run();
    const count = (id: WidgetId) => widgetOf<CountWidget>(widgets, id).value;
    expect(count('vehicles_active')).toBe(2);
    // v2 out of service and v9 in maintenance; the archived v6 and decommissioned v7 are not counted.
    expect(count('vehicles_out_of_service')).toBe(2);
    expect(count('drivers_active')).toBe(1);
    // 15 days exactly, a 400 km gap and an overdue date count; 16 days, 501 km, an unstamped
    // reading, an archived vehicle and an unknown vehicle do not.
    expect(count('maintenance_upcoming')).toBe(3);
    expect(count('documents_expiring')).toBe(4);
    expect(count('insurance_expiring')).toBe(2);
    expect(count('incidents_open')).toBe(5);
    expect(count('incidents_critical')).toBe(2);
  });

  it('averages the daily availability, with the change at local midnight on the later day', async () => {
    const { widgets } = await setup(companyFixture()).run();
    const availability = widgetOf<Extract<DashboardWidget, { kind: 'availability' }>>(
      widgets,
      'availability',
    );
    expect(availability.series).toEqual([
      { day: '2026-10-17', available: 4, live: 5 },
      { day: '2026-10-18', available: 3, live: 5 },
      { day: '2026-10-19', available: 2, live: 4 },
    ]);
    expect(availability.days).toBe(3);
    expect(availability.percent).toBe(63.3);
  });

  it('only judges the days that have already started', async () => {
    const { widgets } = await setup(companyFixture()).run(ALL, {
      from: '2026-10-18',
      to: '2026-10-25',
    });
    const availability = widgetOf<Extract<DashboardWidget, { kind: 'availability' }>>(
      widgets,
      'availability',
    );
    expect(availability.series.map((point) => point.day)).toEqual(['2026-10-18', '2026-10-19']);
    expect(availability.percent).toBe(55);
  });

  it('measures the required documents of vehicles and drivers against the slots', async () => {
    const { widgets } = await setup(companyFixture()).run();
    const ratio = widgetOf<RatioWidget>(widgets, 'documents_valid_pct');
    // 5 live vehicles x 4 required types + 1 active driver x 1 type = 21 slots; 7 + 1 are covered.
    expect(ratio.parts).toEqual([
      { subject: 'vehicle', numerator: 7, denominator: 20 },
      { subject: 'driver', numerator: 1, denominator: 1 },
    ]);
    expect([ratio.numerator, ratio.denominator, ratio.percent]).toEqual([8, 21, 38.1]);
  });

  it('measures the insured share of the active vehicles', async () => {
    const { widgets } = await setup(companyFixture()).run();
    const ratio = widgetOf<RatioWidget>(widgets, 'insurance_valid_pct');
    expect([ratio.numerator, ratio.denominator, ratio.percent]).toEqual([1, 2, 50]);
  });

  it('measures preventive maintenance on time and leaves out what it cannot judge', async () => {
    const { widgets } = await setup(companyFixture()).run();
    const ratio = widgetOf<RatioWidget>(widgets, 'maintenance_on_time');
    expect([ratio.numerator, ratio.denominator, ratio.percent, ratio.excluded]).toEqual([
      1, 2, 50, 1,
    ]);
  });

  it('adds the costs per currency without mixing currencies', async () => {
    const { widgets } = await setup(companyFixture()).run();
    const money = widgetOf<Extract<DashboardWidget, { kind: 'money' }>>(
      widgets,
      'maintenance_cost',
    );
    expect(money.orders).toBe(4);
    expect(money.byCurrency).toEqual([
      { currency: 'MXN', amountMinor: '35500' },
      { currency: 'USD', amountMinor: '100000' },
    ]);
  });

  it('counts the reported and closed cases by month, at the edges of the range', async () => {
    const { widgets } = await setup(companyFixture()).run();
    const monthly = widgetOf<Extract<DashboardWidget, { kind: 'monthly' }>>(
      widgets,
      'incidents_monthly',
    );
    // Reported at 05:59:59Z is still the 16th in Mexico City; 06:00:00Z opens the 17th.
    // Closed at 06:00:00Z on the 20th is the first instant after the range.
    expect(monthly.months).toEqual([{ month: '2026-10', reported: 2, closed: 1 }]);
    expect([monthly.reported, monthly.closed]).toEqual([2, 1]);
  });

  it('splits a range across months in the company zone', async () => {
    const fixture = {
      ...emptyFixture(),
      timeline: [
        // 23:59:59 on 30 September in Mexico City, and the first second of October.
        { reportedAt: '2026-10-01T05:59:59.000Z', firstResolvedAt: null, closedAt: null },
        { reportedAt: '2026-10-01T06:00:00.000Z', firstResolvedAt: null, closedAt: null },
      ],
    };
    const { widgets } = await setup(fixture).run(ALL, { from: '2026-09-25', to: '2026-10-05' });
    const monthly = widgetOf<Extract<DashboardWidget, { kind: 'monthly' }>>(
      widgets,
      'incidents_monthly',
    );
    expect(monthly.months).toEqual([
      { month: '2026-09', reported: 1, closed: 0 },
      { month: '2026-10', reported: 1, closed: 0 },
    ]);
  });

  it('takes the median and the nearest-rank p90 of the first-cycle resolution days', async () => {
    const { widgets } = await setup(companyFixture()).run();
    const duration = widgetOf<Extract<DashboardWidget, { kind: 'duration' }>>(
      widgets,
      'incidents_resolution_time',
    );
    // 2.29, 6.5, 7 and 18 days; the case resolved at the range end (exclusive) is not in it.
    expect([duration.count, duration.medianDays, duration.p90Days]).toEqual([4, 6.75, 18]);
  });
});

describe('a company with no data', () => {
  it('says "sin datos" (null), never 0 % or 100 %', async () => {
    const { widgets } = await setup(emptyFixture()).run();
    expect(widgets).toHaveLength(WIDGETS.length);
    for (const id of ['documents_valid_pct', 'insurance_valid_pct', 'maintenance_on_time'] as const)
      expect(widgetOf<RatioWidget>(widgets, id).percent).toBeNull();
    const availability = widgetOf<Extract<DashboardWidget, { kind: 'availability' }>>(
      widgets,
      'availability',
    );
    expect([availability.percent, availability.days]).toEqual([null, 0]);
    const duration = widgetOf<Extract<DashboardWidget, { kind: 'duration' }>>(
      widgets,
      'incidents_resolution_time',
    );
    expect([duration.count, duration.medianDays, duration.p90Days]).toEqual([0, null, null]);
    expect(widgetOf<CountWidget>(widgets, 'vehicles_active').value).toBe(0);
    expect(
      widgetOf<Extract<DashboardWidget, { kind: 'money' }>>(widgets, 'maintenance_cost'),
    ).toMatchObject({ orders: 0, byCurrency: [] });
  });
});

describe('permissions', () => {
  it('leaves incident and cost widgets out of the payload and never reads their sources', async () => {
    const { calls, run } = setup(companyFixture());
    const dashboard = await run(['view']);
    const ids = dashboard.widgets.map((widget) => widget.id);
    expect(ids).not.toContain('incidents_open');
    expect(ids).not.toContain('maintenance_cost');
    expect(ids).toHaveLength(
      WIDGETS.filter((w) => w.permissions.every((p) => p === 'view')).length,
    );
    const text = JSON.stringify(dashboard);
    expect(text).not.toMatch(/incident|siniestro|cost|MXN|USD/i);
    expect(calls.map((call) => call.name)).not.toContain('openCases');
    expect(calls.map((call) => call.name)).not.toContain('timeline');
  });

  it('shows the cost widget only with view and view_costs together', async () => {
    const { run } = setup(companyFixture());
    expect((await run(['view_costs'])).widgets).toEqual([]);
    expect((await run(['view'])).widgets.map((w) => w.id)).not.toContain('maintenance_cost');
    expect((await run(['view', 'view_costs'])).widgets.map((w) => w.id)).toContain(
      'maintenance_cost',
    );
  });

  it('shows only incident widgets to a reader with incidents:view alone', async () => {
    const { run } = setup(companyFixture());
    const ids = (await run(['incidents:view'])).widgets.map((widget) => widget.id);
    expect(ids).toEqual([
      'incidents_open',
      'incidents_critical',
      'incidents_monthly',
      'incidents_resolution_time',
    ]);
  });

  it('returns no widget and reads nothing for a reader with no permission', async () => {
    const { calls, run } = setup(companyFixture());
    const dashboard = await run([]);
    expect(dashboard.widgets).toEqual([]);
    // Only the company parameters (zone and window) are read to resolve the request.
    expect(calls.map((call) => call.name)).toEqual(['company']);
  });

  it('names the permissions of every widget in the catalog', () => {
    const needing = (permission: Permission) =>
      WIDGETS.filter((widget) => widget.permissions.includes(permission)).map((w) => w.id);
    expect(needing('incidents:view')).toEqual([
      'incidents_open',
      'incidents_critical',
      'incidents_monthly',
      'incidents_resolution_time',
    ]);
    expect(needing('view_costs')).toEqual(['maintenance_cost']);
  });
});

describe('the area filter', () => {
  it('hands the area and its descendants to every source and keeps the orders of those vehicles', async () => {
    const fixture: Fixture = {
      ...companyFixture(),
      areaSubtree: { parent: ['parent', 'child-1', 'child-2'] },
      vehicles: companyFixture().vehicles.filter((vehicle) => vehicle.id === 'v3'),
    };
    const { calls, run } = setup(fixture);
    const dashboard = await run(ALL, { ...RANGE, areaId: 'parent' });
    const area = ['parent', 'child-1', 'child-2'];
    expect(dashboard.areaId).toBe('parent');
    for (const name of ['vehicles', 'employees', 'openCases', 'timeline'])
      expect(calls.find((call) => call.name === name)?.args[1]).toEqual(area);
    // Only the corrective order of v3 is left of the four closed orders.
    const money = widgetOf<Extract<DashboardWidget, { kind: 'money' }>>(
      dashboard.widgets,
      'maintenance_cost',
    );
    expect(money.orders).toBe(1);
    // The document and policy counts are restricted to the owners of the area.
    expect(calls.find((call) => call.name === 'documents.countExpiring')?.args[2]).toEqual({
      vehicle: ['v3'],
      employee: ['e1', 'e2', 'e3'],
    });
    expect(calls.find((call) => call.name === 'insurance.countExpiring')?.args[2]).toEqual(['v3']);
    expect(widgetOf<CountWidget>(dashboard.widgets, 'vehicles_active').drilldown.filters).toEqual({
      status: 'active',
      areaId: 'parent',
    });
  });

  it('does not restrict documents or policies without an area filter', async () => {
    const { calls, run } = setup(companyFixture());
    await run();
    expect(calls.find((call) => call.name === 'documents.countExpiring')?.args[2]).toBeNull();
    expect(calls.find((call) => call.name === 'insurance.countExpiring')?.args[2]).toBeNull();
  });

  it('rejects an area that is not the tenant`s as invalid_area', async () => {
    const { run } = setup(companyFixture());
    await expect(run(ALL, { ...RANGE, areaId: 'area-of-b' })).rejects.toMatchObject({
      code: 'invalid_area',
    });
  });
});

describe('drill-down and declarations', () => {
  it('declares formula, numerator, denominator and scope for every widget', async () => {
    const { widgets } = await setup(companyFixture()).run();
    for (const widget of widgets) {
      expect(widget.definition.formula.length).toBeGreaterThan(10);
      expect(['today', 'range']).toContain(widget.scope);
      expect(widget.drilldown.target).toBeTruthy();
    }
    const ratio = widgetOf<RatioWidget>(widgets, 'insurance_valid_pct');
    expect(ratio.definition).toMatchObject({
      numerator: expect.stringContaining('póliza'),
      denominator: 'Vehículos activos',
    });
  });

  it('points each widget at the list that shows the rows it counts', async () => {
    const { widgets, expiryWindowDays } = await setup(companyFixture()).run(ALL, {
      ...RANGE,
      areaId: undefined,
    });
    const target = (id: WidgetId) => widgetOf<DashboardWidget>(widgets, id).drilldown;
    expect(expiryWindowDays).toBe(30);
    expect(target('vehicles_out_of_service')).toEqual({
      target: 'vehicles',
      filters: { status: 'out_of_service,in_maintenance' },
    });
    expect(target('documents_expiring').filters).toEqual({ expiry: 'expiring', withinDays: '30' });
    expect(target('availability')).toEqual({ target: 'vehicle_status', filters: RANGE });
    expect(target('incidents_critical').filters['critical']).toBe('true');
    expect(target('maintenance_on_time').filters).toMatchObject({
      closedFrom: '2026-10-17',
      closedTo: '2026-10-19',
    });
  });
});

describe('queries', () => {
  it('defaults to the 30 days that end today in the company zone', async () => {
    const { service } = setup(companyFixture());
    expect(await service.resolve(TENANT, {})).toEqual({
      areaId: null,
      from: '2026-09-20',
      to: '2026-10-19',
      today: '2026-10-19',
      timeZone: ZONE,
      expiryWindowDays: 30,
    });
  });

  it('uses the company day, not the UTC day, for today', async () => {
    const fixture = companyFixture();
    const { sources } = fixtureSources({
      ...fixture,
      company: { timeZone: 'Asia/Tokyo', expiryWindowDays: 7 },
    });
    const service = new DashboardService(sources, { now: () => new Date('2026-10-19T20:00:00Z') });
    expect(await service.resolve(TENANT, {})).toMatchObject({
      today: '2026-10-20',
      expiryWindowDays: 7,
    });
  });

  it('completes a half-open range', async () => {
    const { service } = setup(companyFixture());
    expect(await service.resolve(TENANT, { to: '2026-10-10' })).toMatchObject({
      from: '2026-09-11',
      to: '2026-10-10',
    });
    expect(await service.resolve(TENANT, { from: '2026-10-01' })).toMatchObject({
      from: '2026-10-01',
      to: '2026-10-19',
    });
    expect(await service.resolve(TENANT, { from: '2026-12-01' })).toMatchObject({
      from: '2026-12-01',
      to: '2026-12-01',
    });
  });

  it.each([
    [{ from: '2026-10-19', to: '2026-10-18' }, 'from'],
    [{ from: '2025-01-01', to: '2026-10-19' }, 'to'],
    [{ from: '2026-02-30' }, 'from'],
    [{ to: 'ayer' }, 'to'],
    [{ from: '1999-12-31' }, 'from'],
    [{ to: '2101-01-01' }, 'to'],
    [{ areaId: 'a b' }, 'area_id'],
    [{ areaId: 7 }, 'area_id'],
  ])('rejects %j', async (query, field) => {
    const { service } = setup(companyFixture());
    const error = await service.resolve(TENANT, query).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AnalyticsError);
    expect(error).toMatchObject({ code: 'invalid_input', field });
  });

  it('accepts a range of exactly 366 days', async () => {
    const { service } = setup(companyFixture());
    await expect(
      service.resolve(TENANT, { from: '2025-10-19', to: '2026-10-19' }),
    ).resolves.toBeDefined();
    expect(await service.resolve(TENANT, { areaId: '' })).toMatchObject({ areaId: null });
  });
});
