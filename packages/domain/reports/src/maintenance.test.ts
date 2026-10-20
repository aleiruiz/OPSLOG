import { describe, expect, it } from 'vitest';
import { ReportError } from './errors.js';
import { ALL, MemorySources, READER, companyA, companyB, runReport } from './test-support.js';

const col = (rows: readonly { readonly [k: string]: unknown }[], key: string) =>
  rows.map((r) => r[key]);
const COSTS = [...READER, 'view_costs'] as const;

describe('report maintenance_plan_vs_actual', () => {
  it('measures each preventive order against the target of its plan, in days and km', async () => {
    const { rows } = await runReport('maintenance_plan_vs_actual', READER, {
      sort: 'targetDate',
      direction: 'asc',
    });
    // w7 (2026-07-10), w1 (2026-09-01), w2 (2026-10-01), w3 (2026-10-10); the corrective ones are not here.
    expect(col(rows, 'targetDate')).toEqual([
      '2026-07-10',
      '2026-09-01',
      '2026-10-01',
      '2026-10-10',
    ]);
    expect(rows[1]).toMatchObject({
      vehicle: 'ECO-1 (PLA-100)',
      area: 'Norte',
      plan: 'cada 90 días / cada 10,000 km',
      status: 'Cerrada',
      actualDate: '2026-09-05',
      deviationDays: 4,
      targetKm: 10000,
      actualKm: 10400,
      deviationKm: 400,
      punctuality: 'Con retraso',
    });
    expect(rows[0]).toMatchObject({ deviationDays: 0, punctuality: 'En fecha' });
    // Done two days early and 100 km short of the target.
    expect(rows[3]).toMatchObject({
      deviationDays: -2,
      deviationKm: -100,
      punctuality: 'Anticipada',
    });
    // Not done and past its target on 2026-10-19: overdue, with no deviation yet.
    expect(rows[2]).toMatchObject({
      actualDate: null,
      deviationDays: null,
      punctuality: 'Vencida sin atender',
    });
  });

  it('filters by area, punctuality, status and the period of the target', async () => {
    const ids = async (filters: Record<string, string>) =>
      col((await runReport('maintenance_plan_vs_actual', READER, { filters })).rows, 'targetDate');
    expect(await ids({ punctuality: 'late' })).toEqual(['2026-09-01']);
    expect(await ids({ areaId: 'a2' })).toEqual(['2026-10-10', '2026-07-10']);
    expect(await ids({ status: 'scheduled' })).toEqual(['2026-10-01']);
    expect(await ids({ from: '2026-09-01', to: '2026-10-01' })).toEqual([
      '2026-10-01',
      '2026-09-01',
    ]);
  });

  it('reads no cost and gives a mechanic-scoped reader nothing', async () => {
    const sources = new MemorySources({ A: companyA(), B: companyB() });
    await runReport('maintenance_plan_vs_actual', ALL, {}, 'A', sources);
    expect(sources.costReads.every((read) => !read.permitted)).toBe(true);
    sources.scopedActors.add('actor-1');
    expect((await runReport('maintenance_plan_vs_actual', ALL, {}, 'A', sources)).rows).toEqual([]);
    expect((await runReport('maintenance_plan_vs_actual', ALL, {}, 'B')).rows).toEqual([]);
  });
});

describe('report maintenance_corrective', () => {
  it('lists the corrective orders with their origin case by folio and the days they stayed open', async () => {
    const { rows } = await runReport('maintenance_corrective', READER, {
      sort: 'createdOn',
      direction: 'asc',
    });
    expect(col(rows, 'description')).toEqual([
      'Cambio de turbo',
      'Ruido en frenos',
      'Fuga de aceite',
    ]);
    expect(rows[0]).toMatchObject({
      vehicle: 'ECO-1 (PLA-100)',
      status: 'Cerrada',
      workshop: 'Taller Norte',
      createdOn: '2026-09-10',
      workDate: '2026-09-12',
      closedOn: '2026-09-15',
      daysOpen: 5,
      reopenCount: 1,
      incident: 'SIN-2026-0001',
    });
    // A cancelled order has no duration; an open one counts up to today (2026-10-19).
    expect(rows[1]).toMatchObject({ status: 'Cancelada', daysOpen: null, incident: null });
    expect(rows[2]).toMatchObject({ status: 'En proceso', daysOpen: 4, workshop: null });
  });

  it('shows the cost per currency only to a reader of costs and never reads it otherwise', async () => {
    const sources = new MemorySources({ A: companyA(), B: companyB() });
    const plain = await runReport(
      'maintenance_corrective',
      READER,
      { columns: ['cost', 'description'] },
      'A',
      sources,
    );
    expect(plain.columns.map((c) => c.id)).toEqual(['description']);
    expect(JSON.stringify(plain.rows)).not.toContain('MXN');
    expect(sources.costReads.at(-1)).toEqual({ permitted: false });
    const full = await runReport(
      'maintenance_corrective',
      COSTS,
      { columns: ['cost', 'description'] },
      'A',
      sources,
    );
    expect(full.rows.find((r) => r['description'] === 'Cambio de turbo')?.['cost']).toBe(
      'MXN 3000.00; USD 1000.00',
    );
    expect(sources.costReads.at(-1)).toEqual({ permitted: true });
  });

  it('filters by origin, status, workshop, area and creation period', async () => {
    const descriptions = async (filters: Record<string, string>) =>
      col((await runReport('maintenance_corrective', READER, { filters })).rows, 'description');
    expect(await descriptions({ origin: 'incident' })).toEqual(['Cambio de turbo']);
    expect(await descriptions({ origin: 'none' })).toEqual(['Fuga de aceite', 'Ruido en frenos']);
    expect(await descriptions({ status: 'cancelled' })).toEqual(['Ruido en frenos']);
    expect(await descriptions({ workshop: 'taller' })).toEqual(['Cambio de turbo']);
    expect(await descriptions({ areaId: 'a2' })).toEqual(['Ruido en frenos']);
    expect(await descriptions({ from: '2026-10-01', to: '2026-10-10' })).toEqual([
      'Ruido en frenos',
    ]);
  });
});

describe('report maintenance_costs', () => {
  it('is only for a reader of costs: it is not even listed without the permission', async () => {
    await expect(runReport('maintenance_costs', READER)).rejects.toThrow(ReportError);
  });

  it('totals the finished orders per vehicle and currency, without adding currencies', async () => {
    const { rows } = await runReport('maintenance_costs', COSTS, { sort: 'vehicle' });
    expect(rows).toHaveLength(3);
    const mxn = rows.find((r) => r['vehicle'] === 'ECO-1 (PLA-100)' && r['currency'] === 'MXN');
    // w1 (labor 1200.00 + parts 500.50) and w4 (external 3000.00): 4700.50 over 200 km.
    expect(mxn).toMatchObject({
      orders: 2,
      labor: 1200,
      parts: 500.5,
      externalService: 3000,
      other: 0,
      total: 4700.5,
      kmSpan: 200,
      costPerKm: 23.5025,
    });
    const usd = rows.find((r) => r['currency'] === 'USD');
    expect(usd).toMatchObject({ orders: 1, parts: 1000, total: 1000, costPerKm: 5 });
    // ECO-2: w3 and w7 (1300.00 in 1.900 km).
    expect(rows.find((r) => r['vehicle'] === 'ECO-2 (PLA-200)')).toMatchObject({
      total: 1300,
      kmSpan: 1900,
      costPerKm: 0.6842,
    });
  });

  it('gives no cost per km without two odometer readings that advanced', async () => {
    const data = companyA();
    for (const order of data.workOrders)
      if (order.id === 'w4') (order as { actualKm: number | null }).actualKm = null;
    const sources = new MemorySources({ A: data });
    const { rows } = await runReport('maintenance_costs', COSTS, {}, 'A', sources);
    expect(
      rows.find((r) => r['vehicle'] === 'ECO-1 (PLA-100)' && r['currency'] === 'MXN'),
    ).toMatchObject({ total: 4700.5, kmSpan: null, costPerKm: null });
  });

  it('narrows by period and kind before totalling, and by area', async () => {
    const totals = async (filters: Record<string, string>) =>
      (await runReport('maintenance_costs', COSTS, { filters })).rows.map((r) => [
        r['vehicle'],
        r['currency'],
        r['total'],
      ]);
    expect(await totals({ kind: 'corrective' })).toEqual([
      ['ECO-1 (PLA-100)', 'MXN', 3000],
      ['ECO-1 (PLA-100)', 'USD', 1000],
    ]);
    expect(await totals({ from: '2026-09-10', to: '2026-09-30' })).toEqual([
      ['ECO-1 (PLA-100)', 'MXN', 3000],
      ['ECO-1 (PLA-100)', 'USD', 1000],
    ]);
    expect(await totals({ areaId: 'a2' })).toEqual([['ECO-2 (PLA-200)', 'MXN', 1300]]);
  });
});

describe('report maintenance_frequency', () => {
  it('counts the orders of each vehicle and the interval between visits', async () => {
    const { rows } = await runReport('maintenance_frequency', READER, {
      sort: 'vehicle',
      direction: 'asc',
    });
    expect(col(rows, 'vehicle')).toEqual(['ECO-1 (PLA-100)', 'ECO-2 (PLA-200)', 'ECO-3 (PLA-300)']);
    // ECO-1: w1, w2, w4, w6 (the cancelled one is not counted); visits on 09-05 and 09-12.
    expect(rows[0]).toMatchObject({
      orders: 4,
      preventive: 2,
      corrective: 2,
      lastOn: '2026-09-12',
      daysSinceLast: 37,
      avgDaysBetween: 7,
      avgKmBetween: 200,
    });
    // ECO-2: w3 on 10-08 and w7 on 07-10, 90 days apart and 1.900 km.
    expect(rows[1]).toMatchObject({
      orders: 2,
      lastOn: '2026-10-08',
      avgDaysBetween: 90,
      avgKmBetween: 1900,
    });
    expect(rows[2]).toMatchObject({ orders: 0, lastOn: null, avgDaysBetween: null });
  });

  it('counts only the orders of the period and filters by area', async () => {
    const { rows } = await runReport('maintenance_frequency', READER, {
      filters: { from: '2026-10-01', to: '2026-10-31' },
      sort: 'vehicle',
    });
    expect(col(rows, 'orders')).toEqual([2, 1, 0]);
    const north = await runReport('maintenance_frequency', READER, { filters: { areaId: 'a1' } });
    expect(col(north.rows, 'vehicle')).toEqual(['ECO-1 (PLA-100)', 'ECO-3 (PLA-300)']);
  });
});
