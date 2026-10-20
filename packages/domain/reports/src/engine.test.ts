import { describe, expect, it } from 'vitest';
import { ReportCatalog, ReportEngine, permittedColumns, planReport } from './engine.js';
import { REPORT_DEFINITIONS, createReportCatalog } from './catalog.js';
import { dayInZone, daysBetween, isDay } from './calendar.js';
import { ReportError } from './errors.js';
import { label, expiryStatus, optionsOf } from './labels.js';
import { fullName } from './rows.js';
import { ALL, READER, engineFor, runReport } from './test-support.js';

const perms = (...p: string[]) => new Set(p) as never as ReadonlySet<'view'>;

describe('catalog', () => {
  it('provides the eight reports of PR 1, each its own definition', () => {
    expect(REPORT_DEFINITIONS.map((d) => d.id)).toEqual([
      'drivers',
      'dispatchers',
      'areas',
      'people_compliance',
      'vehicle_inventory',
      'fleet_status',
      'insurance',
      'vehicle_documents',
    ]);
    for (const definition of REPORT_DEFINITIONS) {
      expect(definition.view).toBe('view');
      expect(definition.columns.length).toBeGreaterThan(3);
      expect(definition.filters.length).toBeGreaterThan(0);
      expect(definition.formats).toContain('csv');
      expect(definition.formats).toContain('xlsx');
    }
  });

  it('refuses duplicates and unknown default sorts', () => {
    const first = REPORT_DEFINITIONS[0]!;
    expect(() => new ReportCatalog([first, first])).toThrow('duplicate report');
    expect(
      () =>
        new ReportCatalog([{ ...first, id: 'x', defaultSort: { column: 'zz', direction: 'asc' } }]),
    ).toThrow('unknown default sort');
    expect(
      () =>
        new ReportCatalog([{ ...first, id: 'y', columns: [first.columns[0]!, first.columns[0]!] }]),
    ).toThrow('duplicate column');
    expect(createReportCatalog().get('drivers')).toBe(first);
    expect(createReportCatalog().get('nope')).toBeUndefined();
  });
});

describe('summaries', () => {
  it('lists only reports the reader may view and only the columns they may see', () => {
    const { engine } = engineFor();
    expect(engine.summaries(new Set())).toEqual([]);
    const plain = engine.summaries(new Set(READER));
    expect(plain).toHaveLength(8);
    const drivers = plain.find((s) => s.id === 'drivers')!;
    expect(drivers.columns.map((c) => c.id)).not.toContain('licenseNumber');
    const insurance = plain.find((s) => s.id === 'insurance')!;
    expect(insurance.columns.map((c) => c.id)).not.toContain('deductible');
    const full = engine.summaries(new Set(ALL)).find((s) => s.id === 'insurance')!;
    expect(full.columns.map((c) => c.id)).toContain('deductible');
    expect(full.filters.find((f) => f.id === 'status')?.options?.length).toBe(3);
  });
});

describe('planReport', () => {
  const drivers = REPORT_DEFINITIONS[0];
  const view = new Set(READER);

  it('needs the view permission', () => {
    expect(() => planReport(drivers, new Set(), {})).toThrow(ReportError);
    try {
      planReport(drivers, new Set(), {});
    } catch (e) {
      expect((e as ReportError).code).toBe('forbidden');
    }
  });

  it('rejects unknown reports, columns, filters, sorts and directions', () => {
    const { engine } = engineFor();
    expect(() => engine.plan('nope', view)).toThrow(expect.objectContaining({ code: 'not_found' }));
    expect(() => planReport(drivers, view, { columns: ['zz'] })).toThrow(
      expect.objectContaining({ code: 'invalid_input', field: 'columns' }),
    );
    expect(() => planReport(drivers, view, { columns: ['name', 'name'] })).toThrow(
      expect.objectContaining({ field: 'columns' }),
    );
    expect(() => planReport(drivers, view, { columns: [] })).toThrow(
      expect.objectContaining({ field: 'columns' }),
    );
    expect(() => planReport(drivers, view, { columns: ['licenseNumber'] })).toThrow(
      expect.objectContaining({ field: 'columns' }),
    );
    expect(() => planReport(drivers, view, { filters: { zz: 'x' } })).toThrow(
      expect.objectContaining({ field: 'filters' }),
    );
    expect(() => planReport(drivers, view, { sort: 'zz' })).toThrow(
      expect.objectContaining({ field: 'sort' }),
    );
    expect(() => planReport(drivers, view, { direction: 'up' as never })).toThrow(
      expect.objectContaining({ field: 'direction' }),
    );
  });

  it('validates every filter kind', () => {
    const bad =
      (filters: Record<string, string>, id = 'drivers') =>
      () =>
        planReport(createReportCatalog().get(id)!, view, { filters });
    expect(bad({ status: 'vacation' })).toThrow(expect.objectContaining({ field: 'status' }));
    expect(bad({ areaId: 'a b' })).toThrow(expect.objectContaining({ field: 'areaId' }));
    expect(bad({ licenseFrom: '2026-02-30' })).toThrow(
      expect.objectContaining({ field: 'licenseFrom' }),
    );
    expect(bad({ licenseType: '' })).toThrow(expect.objectContaining({ field: 'licenseType' }));
    expect(bad({ licenseType: 'x'.repeat(101) })).toThrow(
      expect.objectContaining({ field: 'licenseType' }),
    );
    expect(bad({ licenseType: '   ' })).toThrow(expect.objectContaining({ field: 'licenseType' }));
    expect(bad({ yearFrom: 'abc' }, 'vehicle_inventory')).toThrow(
      expect.objectContaining({ field: 'yearFrom' }),
    );
    const ok = planReport(drivers, view, { filters: { licenseType: ' federal ', areaId: 'a1' } });
    expect([...ok.filters]).toEqual([
      ['licenseType', 'federal'],
      ['areaId', 'a1'],
    ]);
  });

  it('picks columns in the requested order and keeps the default sort', () => {
    const plan = planReport(drivers, view, { columns: ['status', 'name'] });
    expect(plan.columns.map((c) => c.id)).toEqual(['status', 'name']);
    expect(plan.sort).toEqual({ column: 'name', direction: 'asc' });
    expect(planReport(drivers, view, { sort: 'status' }).sort).toEqual({
      column: 'status',
      direction: 'asc',
    });
    expect(permittedColumns(drivers, view).some((c) => c.sensitivity)).toBe(false);
    void perms;
  });
});

describe('run', () => {
  it('keeps the original order of equal values (stable sort)', async () => {
    const result = await runReport('vehicle_inventory', READER, {
      sort: 'make',
      columns: ['economicNumber', 'make'],
    });
    expect(result.rows.map((r) => r['economicNumber'])).toEqual(['ECO-1', 'ECO-2', 'ECO-3']);
  });
});

describe('helpers', () => {
  it('calendar', () => {
    expect(dayInZone(new Date('2026-10-10T03:00:00Z'), 'America/Mexico_City')).toBe('2026-10-09');
    expect(daysBetween('2026-10-01', '2026-10-19')).toBe(18);
    expect(isDay('2026-02-30')).toBe(false);
    expect(isDay('2026-02-28')).toBe(true);
    expect(isDay('x')).toBe(false);
  });
  it('labels', () => {
    expect(label({ a: 'A' }, 'a')).toBe('A');
    expect(label({ a: 'A' }, 'z')).toBe('z');
    expect(optionsOf({ a: 'A' })).toEqual([{ value: 'a', label: 'A' }]);
    expect(expiryStatus(null, null)).toBe('valid');
    expect(expiryStatus('2026-01-01', -1)).toBe('expired');
    expect(expiryStatus('2026-01-01', 30)).toBe('expiring');
    expect(expiryStatus('2026-01-01', 31)).toBe('valid');
    expect(fullName({ firstName: 'A', lastName: '' })).toBe('A');
    void ReportEngine;
  });
});
