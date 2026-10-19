import { describe, expect, it } from 'vitest';
import { ReportError } from './errors.js';
import { ALL, MemorySources, READER, companyA, companyB, runReport } from './test-support.js';

const names = (rows: readonly { readonly [k: string]: unknown }[], key = 'name') =>
  rows.map((row) => row[key]);

describe('report drivers', () => {
  it('lists the drivers of the company, ordered by name, with their vehicles and expired documents', async () => {
    const result = await runReport('drivers', READER);
    expect(result.columns.map((c) => c.id)).toEqual([
      'name',
      'employeeNumber',
      'area',
      'position',
      'status',
      'licenseType',
      'licenseExpiresOn',
      'vehicle',
      'expiredDocuments',
    ]);
    expect(names(result.rows)).toEqual(['Ana Zúñiga', 'Beto Álvarez', 'Carla Núñez']);
    expect(result.rows[0]).toMatchObject({
      area: 'Norte',
      status: 'Activo',
      licenseType: 'federal',
      licenseExpiresOn: '2026-11-01',
      vehicle: 'ECO-1, ECO-2',
      expiredDocuments: 0,
    });
    expect(result.rows[1]).toMatchObject({
      status: 'Suspendido',
      vehicle: 'ECO-2',
      expiredDocuments: 2,
    });
    expect(result.rows[2]).toMatchObject({ status: 'Baja', vehicle: null });
    expect(result.total).toBe(3);
  });

  it('filters by area, status, license type, license validity range, vehicle and hire date', async () => {
    const ids = async (filters: Record<string, string>) =>
      names((await runReport('drivers', READER, { filters })).rows);
    expect(await ids({ areaId: 'a2' })).toEqual(['Beto Álvarez']);
    expect(await ids({ status: 'terminated' })).toEqual(['Carla Núñez']);
    expect(await ids({ licenseType: 'FEDERAL' })).toEqual(['Ana Zúñiga', 'Carla Núñez']);
    expect(await ids({ licenseFrom: '2026-12-01' })).toEqual(['Beto Álvarez']);
    expect(await ids({ licenseTo: '2026-12-01' })).toEqual(['Ana Zúñiga']);
    expect(await ids({ hasVehicle: 'yes' })).toEqual(['Ana Zúñiga', 'Beto Álvarez']);
    expect(await ids({ hasVehicle: 'no' })).toEqual(['Carla Núñez']);
    expect(await ids({ hiredFrom: '2022-01-01' })).toEqual(['Ana Zúñiga']);
    expect(await ids({ hiredTo: '2022-01-01' })).toEqual(['Beto Álvarez']);
  });

  it('orders by a chosen column and direction, with empty cells last', async () => {
    const asc = await runReport('drivers', READER, { sort: 'licenseExpiresOn' });
    expect(names(asc.rows)).toEqual(['Ana Zúñiga', 'Beto Álvarez', 'Carla Núñez']);
    const desc = await runReport('drivers', READER, {
      sort: 'licenseExpiresOn',
      direction: 'desc',
    });
    expect(names(desc.rows)).toEqual(['Beto Álvarez', 'Ana Zúñiga', 'Carla Núñez']);
  });

  it('keeps the license number out of the plan and out of the source read without view_pii', async () => {
    const sources = new MemorySources({ A: companyA(), B: companyB() });
    const result = await runReport(
      'drivers',
      READER,
      { columns: ['name', 'licenseNumber'] },
      'A',
      sources,
    );
    expect(result.columns.map((c) => c.id)).toEqual(['name']);
    expect(JSON.stringify(result.rows)).not.toContain('LIC-');
    expect(sources.piiReads).toEqual([]);
  });

  it('reads and shows the license number with view_pii, only for the selected column', async () => {
    const sources = new MemorySources({ A: companyA(), B: companyB() });
    const result = await runReport(
      'drivers',
      ALL,
      { columns: ['name', 'licenseNumber'] },
      'A',
      sources,
    );
    expect(result.rows.map((r) => r['licenseNumber'])).toEqual([
      'LIC-ANA-001',
      'LIC-BETO-002',
      null,
    ]);
    expect(sources.piiReads).toEqual([{ tenantId: 'A', fields: ['licenseNumber'] }]);
    const without = new MemorySources({ A: companyA(), B: companyB() });
    await runReport('drivers', ALL, { columns: ['name'] }, 'A', without);
    expect(without.piiReads).toEqual([]);
  });

  it('refuses to order by a column the reader may not see', async () => {
    await expect(runReport('drivers', READER, { sort: 'licenseNumber' })).rejects.toMatchObject({
      code: 'forbidden',
      field: 'sort',
    });
  });

  it('never shows the other company', async () => {
    const result = await runReport('drivers', ALL, { columns: ['name', 'licenseNumber'] }, 'B');
    expect(result.rows).toEqual([{ name: 'Bruno Bravo', licenseNumber: 'LIC-BRUNO-777' }]);
  });
});

describe('report dispatchers', () => {
  it('lists the dispatchers without contact data for a plain reader', async () => {
    const result = await runReport('dispatchers', READER);
    expect(result.columns.map((c) => c.id)).toEqual([
      'name',
      'employeeNumber',
      'area',
      'position',
      'status',
    ]);
    expect(result.rows).toEqual([
      {
        name: 'Diego Soto',
        employeeNumber: 'D-01',
        area: 'Norte',
        position: 'Turno noche',
        status: 'Activo',
      },
    ]);
  });

  it('adds phone and email with view_pii and filters by area and status', async () => {
    const sources = new MemorySources({ A: companyA(), B: companyB() });
    const result = await runReport('dispatchers', ALL, {}, 'A', sources);
    expect(result.rows[0]).toMatchObject({
      phone: '+52 55 5555 0101',
      email: 'diego@example.test',
    });
    expect(sources.piiReads[0]?.fields).toEqual(['phone', 'email']);
    expect((await runReport('dispatchers', ALL, { filters: { areaId: 'a2' } })).rows).toEqual([]);
    expect((await runReport('dispatchers', ALL, { filters: { status: 'active' } })).total).toBe(1);
    const plain = JSON.stringify(
      (await runReport('dispatchers', READER, { columns: ['name', 'phone', 'email'] })).rows,
    );
    expect(plain).not.toContain('example.test');
    expect(plain).not.toContain('5555');
  });
});

describe('report areas', () => {
  it('counts the drivers and vehicles that still count in each area', async () => {
    const result = await runReport('areas', READER);
    expect(result.rows).toEqual(
      [
        {
          name: 'Norte',
          code: 'N',
          parent: null,
          responsibles: 2,
          drivers: 1,
          vehicles: 1,
          state: 'Activa',
        },
        {
          name: 'Sur',
          code: null,
          parent: 'Norte',
          responsibles: 0,
          drivers: 1,
          vehicles: 1,
          state: 'Inactiva',
        },
      ].map((row) => ({ ...row })),
    );
  });

  it('filters active and inactive areas', async () => {
    expect(
      (await runReport('areas', READER, { filters: { active: 'inactive' } })).rows.map(
        (r) => r['name'],
      ),
    ).toEqual(['Sur']);
    expect(
      (await runReport('areas', READER, { filters: { active: 'active' } })).rows.map(
        (r) => r['name'],
      ),
    ).toEqual(['Norte']);
  });

  it('sorts descending by vehicle count', async () => {
    const result = await runReport('areas', READER, {
      sort: 'name',
      direction: 'desc',
      columns: ['name'],
    });
    expect(result.rows.map((r) => r['name'])).toEqual(['Sur', 'Norte']);
  });
});

describe('report people_compliance', () => {
  it('lists the documents of people with status and days left in the company zone', async () => {
    const result = await runReport('people_compliance', READER);
    expect(
      result.rows.map((r) => [r['person'], r['document'], r['status'], r['daysLeft']]),
    ).toEqual([
      ['Beto Álvarez', 'Curso de manejo', 'Vencido', -79],
      ['Beto Álvarez', 'Examen médico', 'Vencido', -19],
      ['Ana Zúñiga', 'Examen médico', 'Por vencer', 0],
      ['Elena Ruiz', 'Otro', 'Vigente', 438],
    ]);
    expect(result.columns.map((c) => c.id)).not.toContain('personKind');
  });

  it('filters by area, document type and status', async () => {
    const ids = async (filters: Record<string, string>) =>
      (await runReport('people_compliance', READER, { filters })).rows.map((r) => r['person']);
    expect(await ids({ areaId: 'a2' })).toEqual(['Beto Álvarez', 'Beto Álvarez', 'Elena Ruiz']);
    expect(await ids({ typeCode: 'driving_course' })).toEqual(['Beto Álvarez']);
    expect(await ids({ status: 'expiring' })).toEqual(['Ana Zúñiga']);
  });

  it('offers the PDF format', async () => {
    const { engine } = (await import('./test-support.js')).engineFor();
    const summary = engine.summaries(new Set(['view'])).find((s) => s.id === 'people_compliance');
    expect(summary?.formats).toEqual(['csv', 'xlsx', 'pdf']);
  });
});

describe('errors', () => {
  it('raises typed errors', async () => {
    await expect(runReport('drivers', READER, { filters: { nope: 'x' } })).rejects.toBeInstanceOf(
      ReportError,
    );
  });
});
