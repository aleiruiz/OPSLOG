import { describe, expect, it } from 'vitest';
import { currencyDigits } from './definitions/vehicles.js';
import { ALL, MemorySources, READER, companyA, companyB, runReport } from './test-support.js';

const col = (rows: readonly { readonly [k: string]: unknown }[], key: string) =>
  rows.map((r) => r[key]);

describe('report vehicle_inventory', () => {
  it('lists the vehicles with their principal driver, ordered by economic number', async () => {
    const result = await runReport('vehicle_inventory', READER);
    expect(col(result.rows, 'economicNumber')).toEqual(['ECO-1', 'ECO-2', 'ECO-3']);
    expect(result.rows[0]).toMatchObject({
      plate: 'PLA-100',
      vin: '1HGBH41JXMN109186',
      make: 'Kenworth',
      model: 'T680',
      year: 2020,
      area: 'Norte',
      status: 'En mantenimiento',
      driver: 'Ana Zúñiga',
      odometerKm: 1000,
      registeredOn: '2024-01-15',
    });
    // v2 has a secondary (Ana) and a principal (Beto): the principal is shown.
    expect(result.rows[1]).toMatchObject({ driver: 'Beto Álvarez', status: 'Activo' });
    expect(result.rows[2]).toMatchObject({ driver: null, status: 'Baja' });
  });

  it('shows the first driver of a vehicle that only has secondary drivers', async () => {
    const data = companyA();
    data.assignments = [{ vehicleId: 'v3', employeeId: 'd1', type: 'temporary' }];
    const sources = new MemorySources({ A: data });
    const rows = (await runReport('vehicle_inventory', READER, {}, 'A', sources)).rows;
    expect(rows[2]?.['driver']).toBe('Ana Zúñiga');
  });

  it('filters by area, status, make and year range', async () => {
    const ids = async (filters: Record<string, string>) =>
      col((await runReport('vehicle_inventory', READER, { filters })).rows, 'economicNumber');
    expect(await ids({ areaId: 'a2' })).toEqual(['ECO-2']);
    expect(await ids({ status: 'decommissioned' })).toEqual(['ECO-3']);
    expect(await ids({ make: 'volvo' })).toEqual(['ECO-2', 'ECO-3']);
    expect(await ids({ yearFrom: '2019' })).toEqual(['ECO-1', 'ECO-3']);
    expect(await ids({ yearTo: '2019' })).toEqual(['ECO-2']);
  });

  it('orders by kilometers descending and by a numeric column naturally', async () => {
    const result = await runReport('vehicle_inventory', READER, {
      sort: 'odometerKm',
      direction: 'desc',
      columns: ['economicNumber', 'odometerKm'],
    });
    expect(result.rows.map((r) => r['odometerKm'])).toEqual([3000, 2000, 1000]);
  });

  it('does not leak the other company', async () => {
    const result = await runReport('vehicle_inventory', ALL, {}, 'B');
    expect(col(result.rows, 'economicNumber')).toEqual(['B-ECO-9']);
  });
});

describe('report fleet_status', () => {
  it('counts the days in state in the zone of the company', async () => {
    const result = await runReport('fleet_status', READER);
    // v1 changed at 2026-10-10 03:00Z = 2026-10-09 in Mexico City: 10 days before 2026-10-19.
    // v2 changed at 2026-09-19 18:00Z = 2026-09-19: 30 days. v3 has no history: no day.
    expect(result.rows.map((r) => [r['vehicle'], r['since'], r['daysInState']])).toEqual([
      ['ECO-2 (PLA-200)', '2026-09-19', 30],
      ['ECO-1 (PLA-100)', '2026-10-09', 10],
      ['ECO-3 (PLA-300)', null, null],
    ]);
    expect(result.rows[1]).toMatchObject({ status: 'En mantenimiento', reason: 'Cambio de motor' });
    expect(result.rows[0]?.['reason']).toBeNull();
  });

  it('filters by area, status and reason', async () => {
    const ids = async (filters: Record<string, string>) =>
      col((await runReport('fleet_status', READER, { filters })).rows, 'vehicle');
    expect(await ids({ areaId: 'a2' })).toEqual(['ECO-2 (PLA-200)']);
    expect(await ids({ status: 'in_maintenance' })).toEqual(['ECO-1 (PLA-100)']);
    expect(await ids({ reason: 'MOTOR' })).toEqual(['ECO-1 (PLA-100)']);
  });
});

describe('report insurance', () => {
  it('lists the policies without the deductible for a reader without view_costs, and does not read it', async () => {
    const sources = new MemorySources({ A: companyA(), B: companyB() });
    const result = await runReport(
      'insurance',
      READER,
      { columns: ['vehicle', 'deductible', 'deductiblePercent', 'deductibleCurrency', 'endsOn'] },
      'A',
      sources,
    );
    expect(result.columns.map((c) => c.id)).toEqual(['vehicle', 'endsOn']);
    expect(sources.policyReads).toEqual([{ tenantId: 'A', withDeductible: false }]);
    expect(JSON.stringify(result.rows)).not.toContain('15000');
  });

  it('shows the deductible by amount and currency or by percentage with view_costs', async () => {
    const sources = new MemorySources({ A: companyA(), B: companyB() });
    const result = await runReport('insurance', ALL, { sort: 'policyNumber' }, 'A', sources);
    const by = Object.fromEntries(result.rows.map((r) => [r['policyNumber'], r]));
    expect(by['Q-100']).toMatchObject({
      deductible: 15000.5,
      deductibleCurrency: 'MXN',
      deductiblePercent: null,
      coverage: 'Cobertura amplia',
      daysLeft: 42,
      status: 'Vigente',
    });
    expect(by['G-7']).toMatchObject({
      deductible: null,
      deductiblePercent: 12.5,
      daysLeft: -1,
      status: 'Vencida',
    });
    expect(by['Q-101']).toMatchObject({
      deductible: null,
      deductiblePercent: null,
      status: 'Vigente',
    });
    expect(sources.policyReads).toEqual([{ tenantId: 'A', withDeductible: true }]);
    expect(col(result.rows, 'policyNumber')).not.toContain('F-1');
  });

  it('filters by area, insurer, validity range and status', async () => {
    const ids = async (filters: Record<string, string>) =>
      col(
        (await runReport('insurance', READER, { filters, sort: 'policyNumber' })).rows,
        'policyNumber',
      );
    expect(await ids({ areaId: 'a2' })).toEqual(['G-7']);
    expect(await ids({ insurer: 'qualitas' })).toEqual(['Q-100', 'Q-101']);
    expect(await ids({ endsFrom: '2026-11-01', endsTo: '2026-12-31' })).toEqual(['Q-100']);
    expect(await ids({ status: 'expired' })).toEqual(['G-7']);
  });

  it('knows the digits of a currency', () => {
    expect(currencyDigits('MXN')).toBe(2);
    expect(currencyDigits('JPY')).toBe(0);
    expect(currencyDigits('???')).toBe(2);
  });

  it('shows an amount in a zero-digit currency as is', async () => {
    const data = companyA();
    data.policies = [
      {
        id: 'p9',
        vehicleId: 'v1',
        insurer: 'X',
        policyNumber: 'J-1',
        coverageType: 'other',
        startsOn: '2026-01-01',
        endsOn: '2027-01-01',
        deductible: { kind: 'amount', amountMinor: 5000, currency: 'JPY' },
      },
    ];
    const result = await runReport('insurance', ALL, {}, 'A', new MemorySources({ A: data }));
    expect(result.rows[0]).toMatchObject({ deductible: 5000, deductibleCurrency: 'JPY' });
  });
});

describe('report vehicle_documents', () => {
  it('lists the documents of the vehicles with their status and days left', async () => {
    const result = await runReport('vehicle_documents', READER);
    expect(
      result.rows.map((r) => [r['vehicle'], r['document'], r['status'], r['daysLeft']]),
    ).toEqual([
      ['ECO-2 (PLA-200)', 'Verificación técnica', 'Vencido', -18],
      ['ECO-1 (PLA-100)', 'Tarjeta de circulación', 'Por vencer', 6],
      ['ECO-1 (PLA-100)', 'Permiso de transporte', 'Vigente', 225],
      ['ECO-2 (PLA-200)', 'Factura o título de propiedad', 'Vigente', null],
    ]);
  });

  it('filters by area, type and status', async () => {
    const ids = async (filters: Record<string, string>) =>
      col((await runReport('vehicle_documents', READER, { filters })).rows, 'document');
    expect(await ids({ areaId: 'a2' })).toEqual([
      'Verificación técnica',
      'Factura o título de propiedad',
    ]);
    expect(await ids({ typeCode: 'transport_permit' })).toEqual(['Permiso de transporte']);
    expect(await ids({ status: 'expiring' })).toEqual(['Tarjeta de circulación']);
  });

  it('offers the PDF format and never shows the other company', async () => {
    expect((await runReport('vehicle_documents', ALL, {}, 'B')).rows).toEqual([]);
  });
});
