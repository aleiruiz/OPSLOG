import { describe, expect, it } from 'vitest';
import { MAINTENANCE_ENTITIES, MAINTENANCE_TABLES } from './entities.js';
import {
  AddOccurrenceLifecycle2026101300010,
  CreateMaintenancePlans2026101200010,
} from './migrations.js';

describe('maintenance persistence schema', () => {
  it('keeps every module table tenant-keyed and gives alerts and occurrences unique replay keys', () => {
    expect(MAINTENANCE_ENTITIES.map((entity) => entity.options.tableName).sort()).toEqual(
      Object.values(MAINTENANCE_TABLES).sort(),
    );
    const occurrence = MAINTENANCE_ENTITIES.find(
      (entity) => entity.options.tableName === MAINTENANCE_TABLES.occurrences,
    )!;
    const alert = MAINTENANCE_ENTITIES.find(
      (entity) => entity.options.tableName === MAINTENANCE_TABLES.alerts,
    )!;
    expect(occurrence.options.columns['tenantId']).toMatchObject({
      primary: true,
      name: 'company_id',
    });
    expect(occurrence.options.uniques).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ columns: ['tenantId', 'planId', 'sequence'] }),
        expect.objectContaining({ columns: ['tenantId', 'idempotencyKey'] }),
      ]),
    );
    expect(alert.options.uniques).toEqual([
      expect.objectContaining({ columns: ['tenantId', 'idempotencyKey'] }),
    ]);
  });

  it('creates and reverses only its seven owned tables through the ORM migration runner', async () => {
    const statements: string[] = [];
    const runner = {
      query: async (sql: string) => {
        statements.push(sql);
        return [];
      },
      dropTable: async (name: string) => {
        statements.push(`DROP ${name}`);
      },
    };
    const migration = new CreateMaintenancePlans2026101200010();
    await migration.up(runner as never);
    expect(statements).toHaveLength(7);
    expect(statements.every((sql) => sql.startsWith('CREATE TABLE `opslog_maintenance_'))).toBe(
      true,
    );
    expect(statements.some((sql) => sql.includes('FOREIGN KEY (company_id,workshop_id)'))).toBe(
      true,
    );
    statements.length = 0;
    await migration.down(runner as never);
    expect(statements).toEqual([
      `DROP ${MAINTENANCE_TABLES.alerts}`,
      `DROP ${MAINTENANCE_TABLES.orders}`,
      `DROP ${MAINTENANCE_TABLES.occurrences}`,
      `DROP ${MAINTENANCE_TABLES.versions}`,
      `DROP ${MAINTENANCE_TABLES.plans}`,
      `DROP ${MAINTENANCE_TABLES.mechanics}`,
      `DROP ${MAINTENANCE_TABLES.workshops}`,
    ]);
  });

  it('adds and drops the occurrence lifecycle columns through its own reversible migration', async () => {
    const statements: string[] = [];
    const runner = {
      query: async (sql: string) => {
        statements.push(sql);
        return [];
      },
    };
    const migration = new AddOccurrenceLifecycle2026101300010();
    await migration.up(runner as never);
    await migration.down(runner as never);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain('ADD COLUMN applied_version INT UNSIGNED NOT NULL DEFAULT 0');
    expect(statements[0]).toContain('closure_plan_version');
    expect(statements[0]).toContain('adopted_at');
    expect(statements[1]).toContain('DROP COLUMN applied_version');
  });
});
