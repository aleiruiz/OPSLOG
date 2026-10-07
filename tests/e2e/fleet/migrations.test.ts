import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mysql from 'mysql2/promise';
import { adminUrl, startFleetDatabase, type FleetDatabase } from './mysql.js';

const suite = adminUrl ? describe : describe.skip;

suite('fleet tenant migration composition on real MySQL', () => {
  let database: FleetDatabase;

  beforeAll(async () => {
    database = await startFleetDatabase();
  }, 120_000);

  afterAll(async () => {
    await database?.close();
  }, 60_000);

  it('applies, reverses, reapplies, and idempotently reruns the ordered module migrations', async () => {
    expect(database.appliedMigrations).toEqual([
      'vehicles:2026100600030',
      'areas:2026100600040',
      'employees:2026100600050',
      'documents:2026100600060',
      'insurance:2026100600070',
      'assignments:2026100600080',
      'settings:2026100600090',
      'imports:2026100600090',
    ]);
    const tables = await database.rows<{ name: string }>(
      'SELECT TABLE_NAME AS name FROM information_schema.tables WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
      [database.databaseName],
    );
    expect(tables.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'opslog_vehicles',
        'opslog_vehicle_status_history',
        'opslog_areas',
        'opslog_area_history',
        'opslog_employees',
        'opslog_employee_history',
        'opslog_documents',
        'opslog_document_revisions',
        'opslog_insurance_policies',
        'opslog_insurance_policy_revisions',
        'opslog_vehicle_assignments',
        'opslog_vehicle_assignment_events',
        'opslog_company_settings',
        'opslog_import_jobs',
        'opslog_import_job_rows',
        'opslog_import_job_events',
      ]),
    );
  });

  it('keeps schema-owner DDL outside the runtime account grants', async () => {
    const account = database.accounts.vehicles;
    const runtime = await mysql.createConnection({
      host: database.host,
      port: database.port,
      user: account.username,
      password: account.password,
      database: database.databaseName,
    });
    try {
      await expect(
        runtime.query('CREATE TABLE opslog_runtime_must_not_ddl (id INT PRIMARY KEY)'),
      ).rejects.toThrow(/denied|privilege/i);
      const [rows] = await runtime.query('SELECT id FROM opslog_vehicles LIMIT 0');
      expect(rows).toEqual([]);
    } finally {
      await runtime.end();
    }
  });
});
