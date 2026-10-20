import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { QueryRunner } from 'typeorm';
import {
  createWebhookDataSource,
  createWebhookMigrationDataSource,
  runWebhookMigrations,
} from './data-source.js';
import { WEBHOOK_ENTITIES, WEBHOOK_TABLES as T } from './entities.js';
import {
  CreateWebhooks2026101900070,
  WEBHOOK_MIGRATIONS_TABLE,
  WEBHOOK_MIGRATION_VERSION,
} from './migrations.js';
import { TypeOrmWebhookStore } from './store.js';

const endpoint = { host: '127.0.0.1', port: 3306, database: 'opslog_t_x', password: 'x' };

describe('webhook schema', () => {
  it('creates three tables keyed by company, with the unique key that deduplicates deliveries', async () => {
    const statements: string[] = [];
    const runner = {
      query: async (sql: string) => void statements.push(sql),
      dropTable: async (name: string) => void statements.push(`DROP ${name}`),
    } as unknown as QueryRunner;
    const migration = new CreateWebhooks2026101900070();
    await migration.up(runner);
    expect(statements).toHaveLength(3);
    const all = statements.join('\n');
    expect(all).toContain('UNIQUE KEY ux_delivery_event (company_id,endpoint_id,event_id)');
    expect(all).toContain('PRIMARY KEY (company_id,id)');
    expect(all).toContain('PRIMARY KEY (company_id,driver_id)');
    expect(all).toContain("status IN ('pending','delivered','failed','dead_letter')");
    expect(all).toContain("event_type IN ('ping','vehicle.created'");
    expect(all).toContain('FOREIGN KEY (company_id,endpoint_id)');
    expect(all).toContain('COLLATE=utf8mb4_0900_bin');
    expect(statements.every((sql) => sql.includes('company_id VARCHAR(64)'))).toBe(true);
    // The secret is only ever stored sealed; the receiver's answer is not stored at all.
    expect(all).toContain('secret_sealed');
    expect(all).not.toMatch(/response_body|plain|secret VARCHAR/i);
    await migration.down(runner);
    expect(statements.slice(3)).toEqual([
      `DROP ${T.driverState}`,
      `DROP ${T.deliveries}`,
      `DROP ${T.endpoints}`,
    ]);
    expect(WEBHOOK_MIGRATION_VERSION).toBe('2026101900070');
    expect(WEBHOOK_ENTITIES).toHaveLength(3);
  });

  it('maps booleans in both directions', () => {
    const column = (
      (WEBHOOK_ENTITIES[0]!.options.columns as Record<string, unknown>).active as {
        transformer: { to(v: boolean): number; from(v: number | boolean): boolean };
      }
    ).transformer;
    expect([
      column.to(true),
      column.to(false),
      column.from(1),
      column.from(0),
      column.from(true),
    ]).toEqual([1, 0, true, false, true]);
  });

  it('has its own migrations table and refuses synchronize and startup migrations', async () => {
    const source = createWebhookMigrationDataSource({ ...endpoint, username: 'owner' });
    expect(source.options.migrationsTableName).toBe(WEBHOOK_MIGRATIONS_TABLE);
    expect(source.options.migrations).toEqual([CreateWebhooks2026101900070]);
    (source.options as { synchronize: boolean }).synchronize = true;
    await expect(runWebhookMigrations(source)).rejects.toThrow(/forbidden/);
    (source.options as { synchronize: boolean; migrationsRun: boolean }).synchronize = false;
    (source.options as { migrationsRun: boolean }).migrationsRun = true;
    await expect(runWebhookMigrations(source)).rejects.toThrow(/forbidden/);
  });

  it('refuses a runtime account that is not its own', () => {
    expect(() => createWebhookDataSource({ ...endpoint, username: 'root' })).toThrow(
      /restricted runtime account/,
    );
    const source = createWebhookDataSource({ ...endpoint, username: 'opslog_webhooks_abc' });
    expect(source.options.synchronize).toBe(false);
    expect(source.options.logging).toBe(false);
    expect(() => new TypeOrmWebhookStore({ options: { username: 'root' } } as never)).toThrow(
      /restricted runtime account/,
    );
    expect(() => new TypeOrmWebhookStore({ options: {} } as never)).toThrow(
      /restricted runtime account/,
    );
  });
});
