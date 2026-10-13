import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { QueryRunner } from 'typeorm';
import { createIncidentDataSource } from '../../cases/src/data-source.js';
import { INCIDENT_TABLES } from '../../cases/src/entities.js';
import {
  createIncidentRepairsMigrationDataSource,
  runIncidentRepairsMigrations,
} from './data-source.js';
import { INCIDENT_REPAIR_ENTITIES, IncidentRepairLinkSchema } from './entities.js';
import {
  CreateIncidentRepairLinks2026101700010,
  INCIDENT_REPAIRS_MIGRATIONS_TABLE,
  INCIDENT_REPAIRS_MIGRATION_VERSION,
} from './migrations.js';
import { TypeOrmIncidentRepairStore, linkFrom, linkRow } from './store.js';

const endpoint = { host: '127.0.0.1', port: 3306, database: 'opslog_t_x', password: 'x' };
const LINK = {
  id: 'link-1',
  tenantId: 'tenant-a',
  incidentId: 'incident-1',
  orderId: 'order-1',
  linkedAt: '2026-10-13T18:00:00.123Z',
  linkedBy: 'user-1',
};

describe('incident repair links schema', () => {
  it('creates one table: unique order per tenant, only the incident referenced, no amounts', async () => {
    const statements: string[] = [];
    const runner = {
      query: async (sql: string) => void statements.push(sql),
      dropTable: async (name: string) => void statements.push(`DROP ${name}`),
    } as unknown as QueryRunner;
    const migration = new CreateIncidentRepairLinks2026101700010();
    await migration.up(runner);
    const [sql] = statements as [string];
    expect(statements).toHaveLength(1);
    expect(sql).toContain('PRIMARY KEY (company_id,incident_id,id)');
    expect(sql).toContain('UNIQUE KEY uq_incident_repair_order (company_id,order_id)');
    expect(sql.match(/REFERENCES `([a-z_]+)`/g)).toEqual([
      `REFERENCES \`${INCIDENT_TABLES.incidents}\``,
    ]);
    expect(sql).not.toMatch(/amount|currency|cost/i);
    expect(sql).toContain('COLLATE=utf8mb4_0900_bin');
    await migration.down(runner);
    expect(statements.at(-1)).toBe('DROP opslog_incident_repair_links');
    expect(INCIDENT_REPAIRS_MIGRATION_VERSION).toBe('2026101700010');
  });

  it('has its own migrations table, refuses synchronize and startup migrations', async () => {
    const source = createIncidentRepairsMigrationDataSource({ ...endpoint, username: 'owner' });
    expect(source.options.migrationsTableName).toBe(INCIDENT_REPAIRS_MIGRATIONS_TABLE);
    expect(source.options.migrations).toEqual([CreateIncidentRepairLinks2026101700010]);
    expect(source.options.synchronize).toBe(false);
    (source.options as { synchronize: boolean }).synchronize = true;
    await expect(runIncidentRepairsMigrations(source)).rejects.toThrow('forbidden');
    (source.options as { synchronize: boolean }).synchronize = false;
    (source.options as { migrationsRun: boolean }).migrationsRun = true;
    await expect(runIncidentRepairsMigrations(source)).rejects.toThrow('forbidden');
    let ran: unknown;
    await runIncidentRepairsMigrations({
      options: { synchronize: false, migrationsRun: false },
      runMigrations: async (options: unknown) => void (ran = options),
    } as never);
    expect(ran).toEqual({ transaction: 'all' });
  });

  it('registers its entity in the incidents runtime data source and maps rows without loss', () => {
    const runtime = createIncidentDataSource({ ...endpoint, username: 'opslog_incidents_abc' });
    expect(runtime.options.entities).toEqual(expect.arrayContaining(INCIDENT_REPAIR_ENTITIES));
    expect(linkFrom(linkRow(LINK))).toEqual(LINK);
    expect(Object.keys(IncidentRepairLinkSchema.options.columns).sort()).toEqual(
      Object.keys(linkRow(LINK)).sort(),
    );
  });

  it('joins the transaction of the incident store; an unlink that matches nothing refuses', async () => {
    const calls: string[] = [];
    let affected = 1;
    const manager = {
      getRepository: () => ({
        insert: async () => void calls.push('insert'),
        delete: async () => (calls.push('delete'), { affected }),
      }),
    };
    const base = {
      apply: async (_m: unknown, extra: { run(tx: unknown): Promise<boolean> }) => ({
        applied: await extra.run(manager),
      }),
    };
    const source = createIncidentDataSource({ ...endpoint, username: 'opslog_incidents_abc' });
    const store = new TypeOrmIncidentRepairStore(source, base as never);
    expect(await store.apply({} as never, { kind: 'link', link: LINK } as never)).toEqual({
      applied: true,
    });
    const unlink = { kind: 'unlink', tenantId: 't', incidentId: 'i', linkId: 'l' } as never;
    expect(await store.apply({} as never, unlink)).toEqual({ applied: true });
    affected = 0;
    expect(await store.apply({} as never, unlink)).toEqual({ applied: false });
    expect(calls).toEqual(['insert', 'delete', 'delete']);
    (source.options as { synchronize: boolean }).synchronize = true;
    expect(() => new TypeOrmIncidentRepairStore(source, base as never)).toThrow();
  });
});
