import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mysql from 'mysql2/promise';
import { AUDIT_TABLES } from '../../../packages/persistence/audit/src/index.js';
import { AREA_TABLES } from '../../../packages/persistence/areas/src/index.js';
import { VEHICLE_TABLES } from '../../../packages/persistence/vehicles/src/index.js';
import { EMPLOYEE_TABLES } from '../../../packages/persistence/employees/src/index.js';
import { DOCUMENT_TABLES } from '../../../packages/persistence/documents/src/index.js';
import { POLICY_TABLES } from '../../../packages/persistence/insurance/src/index.js';
import { ASSIGNMENT_TABLES } from '../../../packages/persistence/assignments/src/index.js';
import { SETTINGS_TABLES } from '../../../packages/persistence/settings/src/index.js';
import { IMPORT_TABLES } from '../../../packages/persistence/imports/src/index.js';
import { FILE_TABLES } from '../../../packages/persistence/files/src/index.js';
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
      'files:2026100700010',
      'audit:2026100700010',
    ]);
    expect(database.databaseName).toMatch(/^opslog_t_[a-f0-9]+$/);
    expect(database.tenantB.databaseName).toMatch(/^opslog_t_[a-f0-9]+$/);
    expect(database.tenantB.databaseName).not.toBe(database.databaseName);
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
        FILE_TABLES.records,
        FILE_TABLES.history,
        FILE_TABLES.saga,
        'opslog_audit_local',
        'opslog_audit_delivery',
        'opslog_audit_log',
        'opslog_audit_registry',
        'opslog_audit_local_keys',
      ]),
    );
    const tenantBTables = await database.rowsB<{ name: string }>(
      'SELECT TABLE_NAME AS name FROM information_schema.tables WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
      [database.tenantB.databaseName],
    );
    expect(tenantBTables.map(({ name }) => name)).toContain('opslog_audit_local');
  });

  it('keeps schema-owner DDL outside the runtime account grants', async () => {
    for (const [module, table] of [
      ['vehicles', 'opslog_vehicles'],
      ['files', FILE_TABLES.records],
    ] as const) {
      const account = database.accounts[module];
      const runtime = await mysql.createConnection({
        host: database.host,
        port: database.port,
        user: account.username,
        password: account.password,
        database: database.databaseName,
      });
      try {
        await expect(
          runtime.query(`CREATE TABLE opslog_${module}_runtime_must_not_ddl (id INT PRIMARY KEY)`),
        ).rejects.toThrow(/denied|privilege/i);
        const [rows] = await runtime.query(`SELECT id FROM ${table} LIMIT 0`);
        expect(rows).toEqual([]);
      } finally {
        await runtime.end();
      }
    }
  });

  it('keeps each tenant runtime credential inside its own physical database', async () => {
    const probes = {
      areas: AREA_TABLES.areas,
      vehicles: VEHICLE_TABLES.vehicles,
      employees: EMPLOYEE_TABLES.employees,
      documents: DOCUMENT_TABLES.documents,
      insurance: POLICY_TABLES.policies,
      assignments: ASSIGNMENT_TABLES.assignments,
      settings: SETTINGS_TABLES.settings,
      imports: IMPORT_TABLES.jobs,
      files: FILE_TABLES.records,
      auditRuntime: AUDIT_TABLES.projection,
      auditRelay: AUDIT_TABLES.local,
    } as const;
    const canSelect = async (
      account: { readonly username: string; readonly password: string },
      databaseName: string,
      table: string,
    ): Promise<string | undefined> => {
      let connection: Awaited<ReturnType<typeof mysql.createConnection>> | undefined;
      try {
        connection = await mysql.createConnection({
          host: database.host,
          port: database.port,
          user: account.username,
          password: account.password,
          database: databaseName,
        });
        await connection.query(`SELECT 1 FROM \`${table}\` LIMIT 0`);
        return undefined;
      } catch (error) {
        return (error as { code?: string }).code ?? 'UNKNOWN_DB_ERROR';
      } finally {
        await connection?.end();
      }
    };

    for (const [name, table] of Object.entries(probes) as [
      keyof typeof probes,
      (typeof probes)[keyof typeof probes],
    ][]) {
      const accountA = database.accounts[name];
      const accountB = database.tenantB.accounts[name];
      expect(await canSelect(accountA, database.databaseName, table)).toBeUndefined();
      expect(await canSelect(accountB, database.tenantB.databaseName, table)).toBeUndefined();
      expect(await canSelect(accountA, database.tenantB.databaseName, table)).toMatch(
        /DENIED|PRIVILEGE/i,
      );
      expect(await canSelect(accountB, database.databaseName, table)).toMatch(/DENIED|PRIVILEGE/i);
    }
  });
});
