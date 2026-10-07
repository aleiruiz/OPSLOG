import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminUrl, startFleetDatabase, type FleetDatabase } from './mysql.js';
import { startFleetWorld, type FleetWorld } from './world.js';

const suite = adminUrl ? describe : describe.skip;
const IMPORTS = '/api/imports';
const VEHICLES = '/api/vehicles';
const pad = (value: number) => String(value).padStart(4, '0');

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
