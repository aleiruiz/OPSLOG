import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { QueryRunner } from 'typeorm';
import { createIncidentDataSource } from '../../cases/src/data-source.js';
import { INCIDENT_TABLES } from '../../cases/src/entities.js';
import { createIncidentSlaMigrationDataSource, runIncidentSlaMigrations } from './data-source.js';
import {
  INCIDENT_SLA_ENTITIES,
  INCIDENT_SLA_TABLES as T,
  IncidentSlaAlertSchema,
  IncidentSlaDeliverySchema,
} from './entities.js';
import {
  CreateIncidentSla2026101700030,
  INCIDENT_SLA_MIGRATIONS_TABLE,
  INCIDENT_SLA_MIGRATION_VERSION,
} from './migrations.js';
import { TypeOrmIncidentSlaStore } from './store.js';

const endpoint = { host: '127.0.0.1', port: 3306, database: 'opslog_t_x', password: 'x' };

describe('incident SLA schema', () => {
  it('creates cycles, notices and deliveries with keys, checks and only the incident referenced', async () => {
    const statements: string[] = [];
    const runner = {
      query: async (sql: string) => void statements.push(sql),
      dropTable: async (name: string) => void statements.push(`DROP ${name}`),
    } as unknown as QueryRunner;
    const migration = new CreateIncidentSla2026101700030();
    await migration.up(runner);
    const [cycles, alerts, deliveries] = statements as [string, string, string];
    expect(statements).toHaveLength(3);
    expect(cycles).toContain('PRIMARY KEY (company_id,incident_id,cycle)');
    expect(cycles).toContain('target_days BETWEEN 1 AND 365');
    expect(alerts).toContain(
      'UNIQUE KEY uq_incident_sla_alert (company_id,incident_id,cycle,kind,dedupe_ref)',
    );
    expect(alerts).toContain("kind IN ('assigned','sla_warning'");
    expect(deliveries).toContain('PRIMARY KEY (company_id,alert_id,recipient_id,channel)');
    expect(deliveries).toContain("channel = 'email'");
    expect(deliveries).not.toMatch(/address|email VARCHAR|body|subject/i);
    expect(`${cycles} ${alerts}`.match(/REFERENCES `([a-z_]+)`/g)).toEqual(
      Array(2).fill(`REFERENCES \`${INCIDENT_TABLES.incidents}\``),
    );
    expect(deliveries).toContain(`REFERENCES \`${T.alerts}\``);
    for (const sql of statements) expect(sql).toContain('COLLATE=utf8mb4_0900_bin');
    await migration.down(runner);
    expect(statements.slice(-3)).toEqual([
      `DROP ${T.deliveries}`,
      `DROP ${T.alerts}`,
      `DROP ${T.cycles}`,
    ]);
    expect(INCIDENT_SLA_MIGRATION_VERSION).toBe('2026101700030');
  });

  it('has its own migrations table, refuses synchronize and startup migrations', async () => {
    const source = createIncidentSlaMigrationDataSource({ ...endpoint, username: 'owner' });
    expect(source.options.migrationsTableName).toBe(INCIDENT_SLA_MIGRATIONS_TABLE);
    expect(source.options.migrations).toEqual([CreateIncidentSla2026101700030]);
    (source.options as { synchronize: boolean }).synchronize = true;
    await expect(runIncidentSlaMigrations(source)).rejects.toThrow('forbidden');
    (source.options as { synchronize: boolean }).synchronize = false;
    (source.options as { migrationsRun: boolean }).migrationsRun = true;
    await expect(runIncidentSlaMigrations(source)).rejects.toThrow('forbidden');
    let ran: unknown;
    await runIncidentSlaMigrations({
      options: { synchronize: false, migrationsRun: false },
      runMigrations: async (options: unknown) => void (ran = options),
    } as never);
    expect(ran).toEqual({ transaction: 'all' });
  });

  it('registers its entities in the incidents runtime data source; no entity holds an address or content', () => {
    const runtime = createIncidentDataSource({ ...endpoint, username: 'opslog_incidents_abc' });
    expect(runtime.options.entities).toEqual(expect.arrayContaining(INCIDENT_SLA_ENTITIES));
    expect(Object.keys(IncidentSlaDeliverySchema.options.columns).sort()).toEqual([
      'alertId',
      'attempts',
      'channel',
      'leaseUntil',
      'nextAttemptAt',
      'recipientId',
      'status',
      'tenantId',
    ]);
    expect(Object.keys(IncidentSlaAlertSchema.options.columns)).not.toEqual(
      expect.arrayContaining(['recipient', 'email', 'body', 'note']),
    );
  });

  it('refuses a data source that is not the restricted incidents runtime on MySQL', () => {
    const owner = createIncidentSlaMigrationDataSource({ ...endpoint, username: 'owner' });
    expect(() => new TypeOrmIncidentSlaStore(owner)).toThrow('restricted incidents runtime');
    const runtime = createIncidentDataSource({ ...endpoint, username: 'opslog_incidents_abc' });
    expect(() => new TypeOrmIncidentSlaStore(runtime)).not.toThrow();
    (runtime.options as { synchronize: boolean }).synchronize = true;
    expect(() => new TypeOrmIncidentSlaStore(runtime)).toThrow('synchronize disabled');
  });
});
