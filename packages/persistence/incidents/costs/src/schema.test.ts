import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { QueryRunner } from 'typeorm';
import { createIncidentDataSource } from '../../cases/src/data-source.js';
import { INCIDENT_TABLES } from '../../cases/src/entities.js';
import {
  createIncidentCostsMigrationDataSource,
  runIncidentCostsMigrations,
} from './data-source.js';
import {
  INCIDENT_COST_ENTITIES,
  INCIDENT_COST_TABLES,
  IncidentCostEstimateSchema,
  IncidentCostLineSchema,
  IncidentCostSnapshotSchema,
} from './entities.js';
import {
  CreateIncidentCosts2026101700020,
  INCIDENT_COSTS_MIGRATIONS_TABLE,
  INCIDENT_COSTS_MIGRATION_VERSION,
} from './migrations.js';
import { TypeOrmIncidentCostStore, lineFrom, lineRow, snapshotFrom, snapshotRow } from './store.js';

const endpoint = { host: '127.0.0.1', port: 3306, database: 'opslog_t_x', password: 'x' };
const LINE = {
  id: 'line-1',
  kind: 'expense' as const,
  category: 'towing' as const,
  amount: { amountMinor: '123456789012345', currency: 'MXN' },
  note: 'Grúa',
};
const SNAPSHOT = {
  tenantId: 'tenant-a',
  incidentId: 'incident-1',
  cycle: 2,
  closedAt: '2026-10-13T18:00:00.123Z',
  totals: [{ currency: 'MXN', repairs: '1', expenses: '2', recoveries: '3', companyBorne: '-0' }],
  orders: [{ orderId: 'o1', version: 3, status: 'closed' }],
};

describe('incident costs schema', () => {
  it('creates lines, estimate and snapshots with checks, exact integers and only the incident referenced', async () => {
    const statements: string[] = [];
    const runner = {
      query: async (sql: string) => void statements.push(sql),
      dropTable: async (name: string) => void statements.push(`DROP ${name}`),
    } as unknown as QueryRunner;
    const migration = new CreateIncidentCosts2026101700020();
    await migration.up(runner);
    const [lines, estimates, snapshots] = statements as [string, string, string];
    expect(statements).toHaveLength(3);
    expect(lines).toContain('PRIMARY KEY (company_id,incident_id,id)');
    expect(lines).toContain('amount_minor BIGINT UNSIGNED NOT NULL');
    expect(lines).toContain("kind = 'expense' AND category IN");
    expect(lines).toContain("kind = 'recovery' AND category IN ('insurer','third_party','other')");
    expect(lines).toContain('CHECK (amount_minor > 0)');
    expect(lines).toContain("currency REGEXP '^[A-Z]{3}$'");
    expect(estimates).toContain('PRIMARY KEY (company_id,incident_id)');
    expect(estimates).toContain('CHECK (amount_minor > 0)');
    expect(snapshots).toContain('PRIMARY KEY (company_id,incident_id,cycle)');
    expect(snapshots).toContain("JSON_TYPE(totals) = 'ARRAY'");
    expect(snapshots).toContain("JSON_TYPE(orders) = 'ARRAY'");
    expect(statements.join(' ').match(/REFERENCES `([a-z_]+)`/g)).toEqual(
      Array(3).fill(`REFERENCES \`${INCIDENT_TABLES.incidents}\``),
    );
    expect(statements.join(' ')).not.toMatch(/FLOAT|DOUBLE|DECIMAL/i);
    for (const sql of statements) expect(sql).toContain('COLLATE=utf8mb4_0900_bin');
    await migration.down(runner);
    expect(statements.slice(-3)).toEqual([
      `DROP ${INCIDENT_COST_TABLES.snapshots}`,
      `DROP ${INCIDENT_COST_TABLES.estimates}`,
      `DROP ${INCIDENT_COST_TABLES.lines}`,
    ]);
    expect(INCIDENT_COSTS_MIGRATION_VERSION).toBe('2026101700020');
  });

  it('has its own migrations table, refuses synchronize and startup migrations', async () => {
    const source = createIncidentCostsMigrationDataSource({ ...endpoint, username: 'owner' });
    expect(source.options.migrationsTableName).toBe(INCIDENT_COSTS_MIGRATIONS_TABLE);
    expect(source.options.migrations).toEqual([CreateIncidentCosts2026101700020]);
    (source.options as { synchronize: boolean }).synchronize = true;
    await expect(runIncidentCostsMigrations(source)).rejects.toThrow('forbidden');
    (source.options as { synchronize: boolean }).synchronize = false;
    (source.options as { migrationsRun: boolean }).migrationsRun = true;
    await expect(runIncidentCostsMigrations(source)).rejects.toThrow('forbidden');
    let ran: unknown;
    await runIncidentCostsMigrations({
      options: { synchronize: false, migrationsRun: false },
      runMigrations: async (options: unknown) => void (ran = options),
    } as never);
    expect(ran).toEqual({ transaction: 'all' });
  });

  it('registers its entities in the incidents runtime data source and maps rows without loss', () => {
    const runtime = createIncidentDataSource({ ...endpoint, username: 'opslog_incidents_abc' });
    expect(runtime.options.entities).toEqual(expect.arrayContaining(INCIDENT_COST_ENTITIES));
    expect(lineFrom(lineRow('t', 'i', 4, LINE))).toEqual(LINE);
    expect(lineRow('t', 'i', 4, LINE)).toMatchObject({
      position: 4,
      amountMinor: '123456789012345',
    });
    expect(Object.keys(IncidentCostLineSchema.options.columns).sort()).toEqual(
      Object.keys(lineRow('t', 'i', 0, LINE)).sort(),
    );
    expect(Object.keys(IncidentCostEstimateSchema.options.columns).sort()).toEqual([
      'amountMinor',
      'currency',
      'incidentId',
      'tenantId',
      'updatedAt',
      'updatedBy',
    ]);
    expect(Object.keys(IncidentCostSnapshotSchema.options.columns).sort()).toEqual(
      Object.keys(snapshotRow(SNAPSHOT)).sort(),
    );
    // BIGINT arrives as text (bigNumberStrings); JSON may arrive as text or already parsed.
    expect(
      lineFrom({ ...lineRow('t', 'i', 0, LINE), amountMinor: 5 as never }).amount.amountMinor,
    ).toBe('5');
    expect(snapshotFrom(snapshotRow(SNAPSHOT))).toEqual(SNAPSHOT);
    expect(
      snapshotFrom({
        ...snapshotRow(SNAPSHOT),
        cycle: '2' as never,
        totals: JSON.stringify(SNAPSHOT.totals) as never,
        orders: JSON.stringify(SNAPSHOT.orders) as never,
      }),
    ).toEqual(SNAPSHOT);
  });

  it('joins the transaction of the incident store: replaces lines and estimate, keeps no stale row', async () => {
    const calls: string[] = [];
    const manager = {
      getRepository: (schema: { options: { name: string } }) => ({
        insert: async () => void calls.push(`insert:${schema.options.name}`),
        delete: async () => void calls.push(`delete:${schema.options.name}`),
      }),
    };
    const base = {
      apply: async (_m: unknown, extra: { run(tx: unknown): Promise<boolean> }) => ({
        applied: await extra.run(manager),
      }),
    };
    const source = createIncidentDataSource({ ...endpoint, username: 'opslog_incidents_abc' });
    const store = new TypeOrmIncidentCostStore(source, base as never);
    const change = {
      tenantId: 't',
      incidentId: 'i',
      actorId: 'u',
      at: '2026-10-13T18:00:00.000Z',
      lines: [LINE, { ...LINE, id: 'line-2' }],
      estimate: { amountMinor: '9', currency: 'USD' },
    } as never;
    expect(await store.apply({} as never, change)).toEqual({ applied: true });
    expect(calls).toEqual([
      'delete:IncidentCostLineEntity',
      'insert:IncidentCostLineEntity',
      'insert:IncidentCostLineEntity',
      'delete:IncidentCostEstimateEntity',
      'insert:IncidentCostEstimateEntity',
    ]);
    calls.length = 0;
    await store.apply({} as never, { ...(change as object), lines: [], estimate: null } as never);
    expect(calls).toEqual(['delete:IncidentCostLineEntity', 'delete:IncidentCostEstimateEntity']);
    calls.length = 0;
    await store.saveSnapshot(SNAPSHOT, manager);
    expect(calls).toEqual(['insert:IncidentCostSnapshotEntity']);
    (source.options as { synchronize: boolean }).synchronize = true;
    expect(() => new TypeOrmIncidentCostStore(source, base as never)).toThrow();
  });
});
