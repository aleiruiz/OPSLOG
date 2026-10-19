import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { QueryRunner } from 'typeorm';
import {
  createNotificationDataSource,
  createNotificationMigrationDataSource,
  runNotificationMigrations,
} from './data-source.js';
import { NOTIFICATION_ENTITIES, NOTIFICATION_TABLES as T } from './entities.js';
import {
  CreateNotifications2026101900060,
  NOTIFICATION_MIGRATIONS_TABLE,
  NOTIFICATION_MIGRATION_VERSION,
} from './migrations.js';
import { TypeOrmNotificationStore } from './store.js';

const endpoint = { host: '127.0.0.1', port: 3306, database: 'opslog_t_x', password: 'x' };

describe('notification schema', () => {
  it('creates the five tables with their keys and checks, and drops them on down', async () => {
    const statements: string[] = [];
    const runner = {
      query: async (sql: string) => void statements.push(sql),
      dropTable: async (name: string) => void statements.push(`DROP ${name}`),
    } as unknown as QueryRunner;
    const migration = new CreateNotifications2026101900060();
    await migration.up(runner);
    expect(statements).toHaveLength(5);
    const all = statements.join('\n');
    expect(all).toContain(
      'UNIQUE KEY ux_notice_dedupe (company_id,recipient_id,event_kind,entity_id,date_version,threshold)',
    );
    expect(all).toContain('PRIMARY KEY (company_id,notification_id,channel)');
    expect(all).toContain('PRIMARY KEY (company_id,recipient_id,event_kind)');
    expect(all).toContain('PRIMARY KEY (company_id,recipient_id,entity_type,entity_id)');
    expect(all).toContain("channel IN ('in_app','email')");
    expect(all).toContain("entity_type IN ('vehicle','incident')");
    expect(all).toContain('COLLATE=utf8mb4_0900_bin');
    // Every table is keyed by its company, and none has a column for an address or a message body.
    expect(statements.every((sql) => sql.includes('company_id VARCHAR(64)'))).toBe(true);
    expect(all).not.toMatch(/address|body|subject|email_to/i);
    await migration.down(runner);
    expect(statements.slice(5)).toEqual([
      `DROP ${T.subscriptions}`,
      `DROP ${T.rules}`,
      `DROP ${T.preferences}`,
      `DROP ${T.deliveries}`,
      `DROP ${T.notifications}`,
    ]);
    expect(NOTIFICATION_MIGRATION_VERSION).toBe('2026101900060');
    expect(NOTIFICATION_ENTITIES).toHaveLength(5);
  });

  it('maps booleans in both directions', () => {
    const column = (
      (NOTIFICATION_ENTITIES[0]!.options.columns as Record<string, unknown>).inApp as {
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
    const source = createNotificationMigrationDataSource({ ...endpoint, username: 'owner' });
    expect(source.options.migrationsTableName).toBe(NOTIFICATION_MIGRATIONS_TABLE);
    expect(source.options.migrations).toEqual([CreateNotifications2026101900060]);
    (source.options as { synchronize: boolean }).synchronize = true;
    await expect(runNotificationMigrations(source)).rejects.toThrow(/forbidden/);
    (source.options as { synchronize: boolean; migrationsRun: boolean }).synchronize = false;
    (source.options as { migrationsRun: boolean }).migrationsRun = true;
    await expect(runNotificationMigrations(source)).rejects.toThrow(/forbidden/);
  });

  it('refuses a runtime account that is not its own', () => {
    expect(() => createNotificationDataSource({ ...endpoint, username: 'root' })).toThrow(
      /restricted runtime account/,
    );
    const source = createNotificationDataSource({ ...endpoint, username: 'opslog_notify_abc' });
    expect(source.options.synchronize).toBe(false);
    expect(source.options.logging).toBe(false);
    expect(() => new TypeOrmNotificationStore({ options: { username: 'root' } } as never)).toThrow(
      /restricted runtime account/,
    );
    expect(() => new TypeOrmNotificationStore({ options: {} } as never)).toThrow(
      /restricted runtime account/,
    );
  });
});
