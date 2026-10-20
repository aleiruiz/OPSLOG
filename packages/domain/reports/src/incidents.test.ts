import { describe, expect, it } from 'vitest';
import { ReportError } from './errors.js';
import { ALL, MemorySources, READER, companyA, companyB, runReport } from './test-support.js';

const col = (rows: readonly { readonly [k: string]: unknown }[], key: string) =>
  rows.map((r) => r[key]);
const CASES = [...READER, 'incidents:view'] as const;
const COSTS = [...CASES, 'incidents:view_costs'] as const;

describe('incident reports need the permission of incidents', () => {
  it('refuses a reader of the fleet only, and a mechanic-scoped reader reads no case', async () => {
    for (const id of [
      'incidents_by_period',
      'incidents_by_subject',
      'incidents_distribution',
      'incident_resolution',
      'incident_aging',
    ])
      await expect(runReport(id, READER)).rejects.toThrow(ReportError);
    const sources = new MemorySources({ A: companyA(), B: companyB() });
    sources.scopedActors.add('actor-1');
    expect((await runReport('incidents_by_period', COSTS, {}, 'A', sources)).rows).toEqual([]);
    expect((await runReport('incidents_by_period', COSTS, {}, 'B')).rows).toEqual([]);
  });
});

describe('report incidents_by_period', () => {
  it('counts the cases of each month by severity and state', async () => {
    const { rows } = await runReport('incidents_by_period', CASES);
    expect(col(rows, 'period')).toEqual(['2026-10', '2026-09', '2026-08', '2026-07']);
    expect(rows[0]).toMatchObject({
      total: 2,
      low: 1,
      medium: 1,
      open: 1,
      cancelled: 1,
      closed: 0,
    });
    expect(rows[2]).toMatchObject({ total: 1, critical: 1, closed: 1, totalLoss: 1, open: 0 });
    expect(rows[1]).toMatchObject({ total: 1, high: 1, open: 1 });
  });

  it('puts the cost the company bore per currency in a text, only for a reader of case costs', async () => {
    const sources = new MemorySources({ A: companyA() });
    const columns = ['period', 'total', 'cost'];
    const plain = await runReport('incidents_by_period', CASES, { columns }, 'A', sources);
    expect(plain.columns.map((c) => c.id)).toEqual(['period', 'total']);
    expect(sources.costReads).toEqual([]);
    const { rows } = await runReport('incidents_by_period', COSTS, { columns }, 'A', sources);
    // September: SIN-0001 bore MXN 16500.00 (3000.00 order once + 17500.00 own - 4000.00 recovered) and USD 1000.00.
    expect(rows.find((r) => r['period'] === '2026-09')?.['cost']).toBe('MXN 16500.00; USD 1000.00');
    expect(rows.find((r) => r['period'] === '2026-08')?.['cost']).toBe('MXN 600.00');
    expect(rows.find((r) => r['period'] === '2026-10')?.['cost']).toBeNull();
  });

  it('narrows by type, severity, state, area and period before counting', async () => {
    const totals = async (filters: Record<string, string>) =>
      col((await runReport('incidents_by_period', CASES, { filters })).rows, 'total');
    expect(await totals({ type: 'collision' })).toEqual([1, 1, 1, 1].slice(0, 3));
    expect(await totals({ severity: 'critical' })).toEqual([1]);
    expect(await totals({ status: 'closed' })).toEqual([1, 1]);
    expect(await totals({ areaId: 'a2' })).toEqual([1, 1, 1]);
    expect(await totals({ from: '2026-09-01', to: '2026-09-30' })).toEqual([1]);
  });
});

describe('report incidents_by_subject', () => {
  it('groups the cases by vehicle and by driver, with the average days to resolve', async () => {
    const { rows } = await runReport('incidents_by_subject', CASES, { sort: 'subject' });
    const find = (kind: string, subject: string) =>
      rows.find((r) => r['subjectKind'] === kind && r['subject'] === subject);
    expect(find('Vehículo', 'ECO-1 (PLA-100)')).toMatchObject({
      total: 2,
      open: 2,
      severe: 1,
      lastOn: '2026-10-10',
    });
    expect(find('Vehículo', 'ECO-2 (PLA-200)')).toMatchObject({
      total: 3,
      open: 0,
      severe: 2,
      totalLoss: 1,
      // 13 days (SIN-0002, reported 08-15 and resolved 08-28) and 5 days (SIN-0005).
      avgResolutionDays: 9,
    });
    expect(find('Conductor', 'Ana Zúñiga')).toMatchObject({ total: 2 });
    expect(find('Conductor', 'Beto Álvarez')).toMatchObject({ total: 2, totalLoss: 1 });
    expect(find('Conductor', 'Sin conductor')).toMatchObject({ total: 1 });
  });

  it('can be limited to one kind of subject and to the filters of the cases', async () => {
    const vehicles = await runReport('incidents_by_subject', CASES, {
      filters: { subject: 'vehicle' },
    });
    expect(new Set(col(vehicles.rows, 'subjectKind'))).toEqual(new Set(['Vehículo']));
    const drivers = await runReport('incidents_by_subject', CASES, {
      filters: { subject: 'driver', severity: 'high' },
    });
    expect(col(drivers.rows, 'subject').sort()).toEqual(['Ana Zúñiga', 'Beto Álvarez']);
  });

  it('hides the cost column from a reader without case costs', async () => {
    const plain = await runReport('incidents_by_subject', CASES, { columns: ['subject', 'cost'] });
    expect(plain.columns.map((c) => c.id)).toEqual(['subject']);
    const full = await runReport('incidents_by_subject', COSTS, { columns: ['subject', 'cost'] });
    expect(full.rows.find((r) => r['subject'] === 'ECO-1 (PLA-100)')?.['cost']).toBe(
      'MXN 16500.00; USD 1000.00',
    );
  });
});

describe('report incidents_distribution', () => {
  it('crosses the types with the severities', async () => {
    const { rows } = await runReport('incidents_distribution', CASES, { sort: 'category' });
    expect(rows).toHaveLength(10);
    expect(rows.find((r) => r['category'] === 'Colisión')).toMatchObject({
      low: 0,
      medium: 1,
      high: 2,
      critical: 0,
      total: 3,
    });
    expect(rows.find((r) => r['category'] === 'Robo total')).toMatchObject({
      critical: 1,
      total: 1,
    });
    expect(rows.find((r) => r['category'] === 'Volcadura')).toMatchObject({ total: 0 });
  });

  it('crosses the states with the severities and honors the filters', async () => {
    const byStatus = await runReport('incidents_distribution', CASES, {
      filters: { rows: 'status' },
    });
    expect(byStatus.rows).toHaveLength(10);
    expect(byStatus.rows.find((r) => r['category'] === 'Cerrado')).toMatchObject({
      critical: 1,
      high: 1,
      total: 2,
    });
    const narrow = await runReport('incidents_distribution', CASES, { filters: { areaId: 'a1' } });
    expect(narrow.rows.reduce((sum, r) => sum + Number(r['total']), 0)).toBe(2);
  });
});

describe('report incident_costs', () => {
  it('needs the permission of case costs to be listed at all', async () => {
    await expect(runReport('incident_costs', CASES)).rejects.toThrow(ReportError);
  });

  it('gives one row per case and currency with the totals of INC-COSTS and no column for the driver', async () => {
    const { rows, columns } = await runReport('incident_costs', COSTS, {
      sort: 'folio',
      direction: 'asc',
    });
    expect(columns.map((c) => c.id)).not.toContain('driverBorne');
    expect(columns.map((c) => c.label.toLowerCase()).join('|')).not.toContain('conductor');
    expect(columns.map((c) => c.id)).toContain('otherExpenses');
    expect(rows.map((r) => [r['folio'], r['currency']])).toEqual([
      ['SIN-2026-0001', 'MXN'],
      ['SIN-2026-0001', 'USD'],
      ['SIN-2026-0002', 'MXN'],
      ['SIN-2026-0005', 'MXN'],
    ]);
    // The order of the case counts once: 3000.00 of repairs, not 6000.00.
    expect(rows[0]).toMatchObject({
      repairs: 3000,
      towing: 2500,
      deductible: 15000,
      expenses: 17500,
      recoveries: 4000,
      companyBorne: 16500,
      vehicle: 'ECO-1 (PLA-100)',
    });
    expect(rows[1]).toMatchObject({ currency: 'USD', repairs: 1000, companyBorne: 1000 });
    expect(rows[2]).toMatchObject({ legal: 500, otherExpenses: 100, companyBorne: 600 });
    expect(rows[3]).toMatchObject({ ownRepairs: 5000, recoveries: 1000, companyBorne: 4000 });
  });

  it('filters by case state, type, severity, area, period and currency', async () => {
    const folios = async (filters: Record<string, string>) =>
      col((await runReport('incident_costs', COSTS, { filters })).rows, 'folio');
    expect(await folios({ status: 'closed' })).toEqual(['SIN-2026-0002', 'SIN-2026-0005']);
    expect(await folios({ type: 'theft_total' })).toEqual(['SIN-2026-0002']);
    expect(await folios({ severity: 'high', from: '2026-09-01' })).toEqual([
      'SIN-2026-0001',
      'SIN-2026-0001',
    ]);
    expect(await folios({ areaId: 'a2', to: '2026-07-31' })).toEqual(['SIN-2026-0005']);
  });
});

describe('report incident_resolution', () => {
  it('measures the days to resolve, by stage, and the SLA met, keeping reopened cycles apart', async () => {
    const { rows } = await runReport('incident_resolution', CASES, { sort: 'cycleKind' });
    expect(rows).toHaveLength(3);
    const critical = rows.filter((r) => r['severity'] === 'Crítica');
    const first = critical.find((r) => r['cycleKind'] === 'Primer ciclo');
    expect(first).toMatchObject({
      cycles: 1,
      medianDays: 10,
      p90Days: 10,
      slaMetPct: 0,
      daysReported: 2,
      daysReview: 1,
      daysInsurer: 7,
      daysDirect: 0,
      daysRepair: 0,
    });
    const reopened = critical.find((r) => r['cycleKind'] === 'Reaperturas');
    expect(reopened).toMatchObject({ cycles: 1, medianDays: 2, slaMetPct: 100, daysReported: 2 });
    expect(rows.find((r) => r['severity'] === 'Alta')).toMatchObject({
      cycleKind: 'Primer ciclo',
      cycles: 1,
      medianDays: 5,
      slaMetPct: 100,
      daysReported: 1,
      daysReview: 1,
      daysRepair: 3,
    });
  });

  it('takes the median and p90 of several cycles and ignores cycles without an SLA', async () => {
    const data = companyA();
    data.incidents.push({
      ...data.incidents.find((i) => i.id === 'i5'),
      id: 'i6',
      folio: 'SIN-2026-0006',
    } as (typeof data.incidents)[number]);
    const steps = (data.incidentSteps['i5'] ?? []).map((s) => ({ ...s }));
    steps[3] = { ...steps[3], at: '2026-07-11T15:00:00.000Z' } as (typeof steps)[number];
    data.incidentSteps['i6'] = steps;
    const sources = new MemorySources({ A: data });
    const { rows } = await runReport(
      'incident_resolution',
      CASES,
      { filters: { severity: 'high' } },
      'A',
      sources,
    );
    // i5 resolved in 5 days, i6 in 10 days (and without an SLA): median 7.5, p90 10, SLA judged on i5 only.
    expect(rows[0]).toMatchObject({ cycles: 2, medianDays: 7.5, p90Days: 10, slaMetPct: 100 });
  });
});

describe('report incident_aging', () => {
  it('lists the open cases with their age, range and SLA', async () => {
    const { rows } = await runReport('incident_aging', CASES, {
      sort: 'ageDays',
      direction: 'desc',
    });
    expect(col(rows, 'folio')).toEqual(['SIN-2026-0001', 'SIN-2026-0003']);
    expect(rows[0]).toMatchObject({
      type: 'Colisión',
      severity: 'Alta',
      status: 'En reparación',
      vehicle: 'ECO-1 (PLA-100)',
      driver: 'Ana Zúñiga',
      area: 'Norte',
      reportedOn: '2026-09-08',
      ageDays: 41,
      bucket: '31 a 60 días',
      slaState: 'Vencido',
      deadline: '2026-10-08',
      daysToDeadline: -11,
    });
    expect(rows[1]).toMatchObject({
      ageDays: 9,
      bucket: '8 a 15 días',
      slaState: 'En tiempo',
      driver: null,
    });
  });

  it('filters by range, SLA state, state, severity and folio', async () => {
    const folios = async (filters: Record<string, string>) =>
      col((await runReport('incident_aging', CASES, { filters })).rows, 'folio');
    expect(await folios({ bucket: 'd60' })).toEqual(['SIN-2026-0001']);
    expect(await folios({ sla: 'on_track' })).toEqual(['SIN-2026-0003']);
    expect(await folios({ status: 'reported' })).toEqual(['SIN-2026-0003']);
    expect(await folios({ severity: 'low' })).toEqual(['SIN-2026-0003']);
    expect(await folios({ folio: '0001' })).toEqual(['SIN-2026-0001']);
    expect(await folios({ areaId: 'a2' })).toEqual([]);
  });

  it('does not list closed, cancelled or foreign cases', async () => {
    expect(col((await runReport('incident_aging', ALL)).rows, 'folio')).not.toContain(
      'SIN-2026-0004',
    );
  });
});
