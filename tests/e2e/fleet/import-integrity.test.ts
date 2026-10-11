import { Buffer } from 'node:buffer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminUrl, startFleetDatabase, type FleetDatabase } from './mysql.js';
import { startFleetWorld, type FleetWorld } from './world.js';

const suite = adminUrl ? describe : describe.skip;
const IMPORTS = '/api/imports';
const VEHICLES = '/api/vehicles';
const pad = (value: number) => String(value).padStart(4, '0');

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let value = n;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function xlsxArchive(files: Readonly<Record<string, string>>): Buffer {
  const localParts: Buffer[] = [];
  const directoryParts: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const filename = Buffer.from(name);
    const data = Buffer.from(text);
    let crc = 0xffffffff;
    for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = Buffer.alloc(30 + filename.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(filename.length, 26);
    filename.copy(local, 30);
    localParts.push(local, data);
    const record = Buffer.alloc(46 + filename.length);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(filename.length, 28);
    record.writeUInt32LE(offset, 42);
    filename.copy(record, 46);
    directoryParts.push(record);
    offset += local.length + data.length;
  }
  const directory = Buffer.concat(directoryParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(directoryParts.length, 8);
  end.writeUInt16LE(directoryParts.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, directory, end]);
}

const xlsxPackage = (worksheet: string) => ({
  '[Content_Types].xml':
    '<Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
  '_rels/.rels':
    '<Relationships><Relationship Id="rId0" Type="x/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  'xl/workbook.xml':
    '<workbook xmlns:r="r"><sheets><sheet name="Import" sheetId="1" r:id="rId1"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels':
    '<Relationships><Relationship Id="rId1" Type="x/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
  'xl/worksheets/sheet1.xml': worksheet,
});

const xlsxCell = (column: number, row: number, value: string): string =>
  `<c r="${String.fromCharCode(65 + column)}${row}" t="inlineStr"><is><t>${value}</t></is></c>`;

function vehicleXlsx(areaId: string, invalidFormula = false): string {
  const headers = [
    'economicNumber',
    'plate',
    'make',
    'model',
    'year',
    'areaId',
    'odometerKm',
    'vin',
    'registeredOn',
  ];
  const rows = Array.from({ length: invalidFormula ? 1 : 300 }, (_, index) => {
    const n = index + 1;
    const values = [
      n <= 6 ? `NEW-${pad(n)}` : `XLS-NEW-${pad(n)}`,
      `XLS${pad(n)}`,
      'Toyota',
      'Hilux',
      '2022',
      areaId,
      '120',
      '',
      n > 294 ? '2026-02-31' : '',
    ];
    const cells = values.map((value, column) => xlsxCell(column, n + 1, value)).join('');
    const cellsAfterFormula = values
      .slice(1)
      .map((value, column) => xlsxCell(column + 1, n + 1, value))
      .join('');
    return invalidFormula && n === 1
      ? `<row r="${n + 1}"><c r="A${n + 1}"><f>1+1</f><v>2</v></c>${cellsAfterFormula}</row>`
      : `<row r="${n + 1}">${cells}</row>`;
  });
  const header = `<row r="1">${headers.map((value, column) => xlsxCell(column, 1, value)).join('')}</row>`;
  return xlsxArchive(
    xlsxPackage(`<worksheet><sheetData>${header}${rows.join('')}</sheetData></worksheet>`),
  ).toString('base64');
}

suite('integrated CSV import on real MySQL', () => {
  let database: FleetDatabase;
  let fleet: FleetWorld;

  beforeAll(async () => {
    database = await startFleetDatabase();
    fleet = await startFleetWorld(database);
  }, 120_000);

  afterAll(async () => {
    fleet?.world.dispose();
    await database?.close();
  }, 60_000);

  it('previews 300 CSV rows without writes, commits 288 once, and records value-free durable history', async () => {
    const areaId = await fleet.area(fleet.adminA, 'Importación');
    for (let n = 1; n <= 6; n += 1) {
      const existing = await fleet.adminA.post(VEHICLES, {
        json: {
          economicNumber: `BASE-${pad(n)}`,
          plate: `CSV${pad(n)}`,
          vin: null,
          make: 'Toyota',
          model: 'Hilux',
          year: 2022,
          areaId,
          odometerKm: 5,
        },
      });
      expect(existing.status, existing.text).toBe(201);
    }

    const header = 'economicNumber,plate,make,model,year,areaId,odometerKm,vin,registeredOn';
    const records = Array.from({ length: 300 }, (_, index) => {
      const n = index + 1;
      const economic = n <= 6 ? `NEW-${pad(n)}` : `CSV-NEW-${pad(n)}`;
      const plate = `CSV${pad(n)}`;
      const registeredOn = n > 294 ? '2026-02-31' : '';
      return `${economic},${plate},Toyota,Hilux,2022,${areaId},120,,${registeredOn}`;
    });
    const csv = `${header}\r\n${records.join('\r\n')}\r\n`;
    const before = (await fleet.adminA.get(`${VEHICLES}?includeArchived=true&limit=100`)).json
      .total;
    const preview = await fleet.adminA.post(IMPORTS, {
      json: { entity: 'vehicle', mode: 'dry_run', csv },
    });
    expect(preview.status, preview.text).toBe(201);
    expect(preview.json.job).toMatchObject({
      status: 'validated',
      mode: 'dry_run',
      totalRows: 300,
      validRows: 288,
      invalidRows: 12,
      importedRows: 0,
    });
    expect((await fleet.adminA.get(`${VEHICLES}?includeArchived=true&limit=100`)).json.total).toBe(
      before,
    );
    const previewId = preview.json.job.id as string;
    const errors = await fleet.adminA.get(`${IMPORTS}/${previewId}/rows?outcome=invalid&limit=25`);
    expect(errors.status, errors.text).toBe(200);
    expect(errors.json.total).toBe(12);
    expect(errors.json.items).toHaveLength(12);
    expect(errors.text).not.toMatch(/Toyota|Hilux|CSV-NEW|2026-02-31/);

    const request = {
      entity: 'vehicle',
      mode: 'commit_valid',
      idempotencyKey: 'flt-csv-300-commit-01',
      dryRunJobId: previewId,
      csv,
    };
    const committed = await fleet.adminA.post(IMPORTS, { json: request });
    expect(committed.status, committed.text).toBe(201);
    expect(committed.json.job).toMatchObject({
      status: 'imported',
      validRows: 288,
      invalidRows: 12,
      importedRows: 288,
    });
    const afterCommit = (await fleet.adminA.get(`${VEHICLES}?includeArchived=true&limit=100`)).json
      .total as number;
    expect(afterCommit).toBe(Number(before) + 288);
    const replay = await fleet.adminA.post(IMPORTS, { json: request });
    expect(replay.json).toMatchObject({ replayed: true, job: { id: committed.json.job.id } });
    expect((await fleet.adminA.get(`${VEHICLES}?includeArchived=true&limit=100`)).json.total).toBe(
      afterCommit,
    );

    const otherTenant = await fleet.adminB.get(`${IMPORTS}/${committed.json.job.id}`);
    expect(otherTenant.status).toBe(404);
    const forbidden = await fleet.viewerA.post(IMPORTS, {
      json: { entity: 'vehicle', mode: 'dry_run', csv },
    });
    expect(forbidden.status).toBe(403);

    const foreignAreaCsv = [
      'economicNumber,plate,make,model,year,areaId,odometerKm,vin',
      `FOREIGN-001,FRGN001,Toyota,Hilux,2022,${areaId},10,`,
      '',
    ].join('\r\n');
    const vehicleCountB = await database.rowsB<{ count: number }>(
      'SELECT COUNT(*) AS count FROM opslog_vehicles WHERE company_id = ?',
      [fleet.tenantB],
    );
    const foreignPreview = await fleet.adminB.post(IMPORTS, {
      json: { entity: 'vehicle', mode: 'dry_run', csv: foreignAreaCsv },
    });
    expect(foreignPreview.status, foreignPreview.text).toBe(201);
    expect(foreignPreview.json.job).toMatchObject({ validRows: 0, invalidRows: 1 });
    const foreignCommit = await fleet.adminB.post(IMPORTS, {
      json: {
        entity: 'vehicle',
        mode: 'commit_valid',
        idempotencyKey: 'flt-foreign-area-commit-01',
        dryRunJobId: foreignPreview.json.job.id,
        csv: foreignAreaCsv,
      },
    });
    expect(foreignCommit.status, foreignCommit.text).toBe(201);
    expect(foreignCommit.json.job).toMatchObject({
      status: 'failed',
      importedRows: 0,
      invalidRows: 1,
    });
    expect(foreignCommit.text).not.toContain(areaId);
    expect(await fleet.adminA.get(`${IMPORTS}/${foreignCommit.json.job.id}`)).toMatchObject({
      status: 404,
    });
    const vehicleCountBAfter = await database.rowsB<{ count: number }>(
      'SELECT COUNT(*) AS count FROM opslog_vehicles WHERE company_id = ?',
      [fleet.tenantB],
    );
    expect(vehicleCountBAfter).toEqual(vehicleCountB);

    const storedJob = await database.rows<{ company_id: string; total_rows: number }>(
      'SELECT company_id, total_rows FROM opslog_import_jobs WHERE id = ?',
      [committed.json.job.id],
    );
    expect(storedJob).toEqual([{ company_id: fleet.tenantA, total_rows: 300 }]);
    const storedRows = await database.rows<{ code: string | null; column_names: string | null }>(
      'SELECT code, column_names FROM opslog_import_job_rows WHERE company_id = ? AND job_id = ?',
      [fleet.tenantA, committed.json.job.id],
    );
    expect(storedRows).toHaveLength(300);
    expect(JSON.stringify(storedRows)).not.toMatch(/Toyota|Hilux|CSV-NEW|2026-02-31/);
    const history = await database.rows<{ kind: string; accepted_rows: number | null }>(
      'SELECT kind, accepted_rows FROM opslog_import_job_events WHERE company_id = ? AND job_id = ? ORDER BY seq',
      [fleet.tenantA, committed.json.job.id],
    );
    expect(history).toEqual([
      { kind: 'started', accepted_rows: null },
      { kind: 'imported', accepted_rows: 288 },
    ]);
  }, 120_000);

  it('imports a driver CSV only with PII permission, seals personal fields, and stores value-free history', async () => {
    const areaId = await fleet.area(fleet.adminA, 'Conductores importados');
    const csv = [
      'kind,firstName,lastName,areaId,employeeNumber,idType,nationalId,phone,email,licenseNumber,licenseType,licenseExpiresOn',
      `driver,Lucia,Operadora,${areaId},EMP-FLT-009,ine,SYNTH-NID-009,+525555501234,operadora009@synthetic.example,SYNTH-LIC-009,c,2099-12-31`,
      '',
    ].join('\r\n');
    const denied = await fleet.viewerA.post(IMPORTS, {
      json: { entity: 'employee', mode: 'dry_run', csv },
    });
    expect(denied.status).toBe(403);

    const preview = await fleet.adminA.post(IMPORTS, {
      json: { entity: 'employee', mode: 'dry_run', csv },
    });
    expect(preview.status, preview.text).toBe(201);
    expect(preview.json.job).toMatchObject({
      entity: 'employee',
      status: 'validated',
      validRows: 1,
      invalidRows: 0,
      importedRows: 0,
    });
    const before = await database.rows<{ count: number }>(
      'SELECT COUNT(*) AS count FROM opslog_employees WHERE company_id = ?',
      [fleet.tenantA],
    );
    const committed = await fleet.adminA.post(IMPORTS, {
      json: {
        entity: 'employee',
        mode: 'commit_valid',
        idempotencyKey: 'flt-employee-csv-commit-01',
        dryRunJobId: preview.json.job.id,
        csv,
      },
    });
    expect(committed.status, committed.text).toBe(201);
    expect(committed.json.job).toMatchObject({
      status: 'imported',
      validRows: 1,
      invalidRows: 0,
      importedRows: 1,
    });
    const importedRows = await fleet.adminA.get(
      `${IMPORTS}/${committed.json.job.id}/rows?outcome=imported`,
    );
    const employeeId = importedRows.json.items[0].entityId as string;
    const storedEmployee = await database.rows<{
      company_id: string;
      national_id_enc: string;
      phone_enc: string;
      email_enc: string;
      license_number_enc: string;
    }>(
      'SELECT company_id, national_id_enc, phone_enc, email_enc, license_number_enc FROM opslog_employees WHERE id = ?',
      [employeeId],
    );
    expect(storedEmployee).toHaveLength(1);
    expect(storedEmployee[0]).toMatchObject({ company_id: fleet.tenantA });
    for (const column of [
      'national_id_enc',
      'phone_enc',
      'email_enc',
      'license_number_enc',
    ] as const) {
      expect(storedEmployee[0]?.[column]).toMatch(/^pii1\./);
      expect(storedEmployee[0]?.[column]).not.toContain('SYNTH-');
      expect(storedEmployee[0]?.[column]).not.toContain('operadora009@');
      expect(storedEmployee[0]?.[column]).not.toContain('+525555501234');
    }
    const jobRows = await database.rows<{ code: string | null; column_names: string | null }>(
      'SELECT code, column_names FROM opslog_import_job_rows WHERE company_id = ? AND job_id = ?',
      [fleet.tenantA, committed.json.job.id],
    );
    const events = await fleet.adminA.get(`${IMPORTS}/${committed.json.job.id}/history`);
    const surfaces = [preview.text, committed.text, JSON.stringify(jobRows), events.text].join(
      '\n',
    );
    expect(jobRows).toEqual([{ code: null, column_names: null }]);
    expect(surfaces).not.toMatch(/SYNTH-NID|SYNTH-LIC|operadora009@|\+525555501234/);
    const after = await database.rows<{ count: number }>(
      'SELECT COUNT(*) AS count FROM opslog_employees WHERE company_id = ?',
      [fleet.tenantA],
    );
    expect(Number(after[0]?.count) - Number(before[0]?.count)).toBe(1);
    expect((await fleet.adminB.get(`${IMPORTS}/${committed.json.job.id}`)).status).toBe(404);
  }, 60_000);
});

suite('integrated XLSX import on real MySQL', () => {
  let database: FleetDatabase;
  let fleet: FleetWorld;

  beforeAll(async () => {
    database = await startFleetDatabase();
    fleet = await startFleetWorld(database);
  }, 120_000);

  afterAll(async () => {
    fleet?.world.dispose();
    await database?.close();
  }, 60_000);

  it('previews 300 XLSX rows without writes, commits 288 once, and records value-free durable history', async () => {
    const areaId = await fleet.area(fleet.adminA, 'Importación XLSX');
    for (let n = 1; n <= 6; n += 1) {
      const existing = await fleet.adminA.post(VEHICLES, {
        json: {
          economicNumber: `BASE-XLS-${pad(n)}`,
          plate: `XLS${pad(n)}`,
          vin: null,
          make: 'Toyota',
          model: 'Hilux',
          year: 2022,
          areaId,
          odometerKm: 5,
        },
      });
      expect(existing.status, existing.text).toBe(201);
    }

    const xlsxBase64 = vehicleXlsx(areaId);
    const before = (await fleet.adminA.get(`${VEHICLES}?includeArchived=true&limit=100`)).json
      .total;
    const preview = await fleet.adminA.post(IMPORTS, {
      json: { entity: 'vehicle', mode: 'dry_run', xlsxBase64 },
    });
    expect(preview.status, preview.text).toBe(201);
    expect(preview.json.job).toMatchObject({
      status: 'validated',
      mode: 'dry_run',
      totalRows: 300,
      validRows: 288,
      invalidRows: 12,
      importedRows: 0,
    });
    expect((await fleet.adminA.get(`${VEHICLES}?includeArchived=true&limit=100`)).json.total).toBe(
      before,
    );
    const previewId = preview.json.job.id as string;
    const errors = await fleet.adminA.get(`${IMPORTS}/${previewId}/rows?outcome=invalid&limit=25`);
    expect(errors.status, errors.text).toBe(200);
    expect(errors.json.total).toBe(12);
    expect(errors.json.items).toHaveLength(12);
    expect(errors.text).not.toMatch(/Toyota|Hilux|XLS-NEW|2026-02-31/);

    const request = {
      entity: 'vehicle',
      mode: 'commit_valid',
      idempotencyKey: 'flt-xlsx-300-commit-01',
      dryRunJobId: previewId,
      xlsxBase64,
    };
    const committed = await fleet.adminA.post(IMPORTS, { json: request });
    expect(committed.status, committed.text).toBe(201);
    expect(committed.json.job).toMatchObject({
      status: 'imported',
      validRows: 288,
      invalidRows: 12,
      importedRows: 288,
    });
    const afterCommit = (await fleet.adminA.get(`${VEHICLES}?includeArchived=true&limit=100`)).json
      .total as number;
    expect(afterCommit).toBe(Number(before) + 288);
    const replay = await fleet.adminA.post(IMPORTS, { json: request });
    expect(replay.json).toMatchObject({ replayed: true, job: { id: committed.json.job.id } });
    expect((await fleet.adminA.get(`${VEHICLES}?includeArchived=true&limit=100`)).json.total).toBe(
      afterCommit,
    );

    const otherTenant = await fleet.adminB.get(`${IMPORTS}/${committed.json.job.id}`);
    expect(otherTenant.status).toBe(404);
    const forbidden = await fleet.viewerA.post(IMPORTS, {
      json: { entity: 'vehicle', mode: 'dry_run', xlsxBase64 },
    });
    expect(forbidden.status).toBe(403);

    const formula = await fleet.adminA.post(IMPORTS, {
      json: { entity: 'vehicle', mode: 'dry_run', xlsxBase64: vehicleXlsx(areaId, true) },
    });
    expect(formula.status).toBe(400);
    const oversized = await fleet.adminA.post(IMPORTS, {
      json: {
        entity: 'vehicle',
        mode: 'dry_run',
        xlsxBase64: Buffer.alloc(400_001).toString('base64'),
      },
    });
    expect(oversized.status).toBe(400);
    expect((await fleet.adminA.get(`${VEHICLES}?includeArchived=true&limit=100`)).json.total).toBe(
      afterCommit,
    );

    const storedJob = await database.rows<{ company_id: string; total_rows: number }>(
      'SELECT company_id, total_rows FROM opslog_import_jobs WHERE id = ?',
      [committed.json.job.id],
    );
    expect(storedJob).toEqual([{ company_id: fleet.tenantA, total_rows: 300 }]);
    const storedRows = await database.rows<{ code: string | null; column_names: string | null }>(
      'SELECT code, column_names FROM opslog_import_job_rows WHERE company_id = ? AND job_id = ?',
      [fleet.tenantA, committed.json.job.id],
    );
    expect(storedRows).toHaveLength(300);
    expect(JSON.stringify(storedRows)).not.toMatch(/Toyota|Hilux|XLS-NEW|2026-02-31/);
    const history = await database.rows<{ kind: string; accepted_rows: number | null }>(
      'SELECT kind, accepted_rows FROM opslog_import_job_events WHERE company_id = ? AND job_id = ? ORDER BY seq',
      [fleet.tenantA, committed.json.job.id],
    );
    expect(history).toEqual([
      { kind: 'started', accepted_rows: null },
      { kind: 'imported', accepted_rows: 288 },
    ]);
  }, 120_000);
});
