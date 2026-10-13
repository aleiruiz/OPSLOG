import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { DataSource, EntityManager, QueryRunner } from 'typeorm';
import type { IncidentClosure } from '../../../../domain/incidents/workflow/src/index.js';
import { createIncidentDataSource } from '../../cases/src/data-source.js';
import { INCIDENT_TABLES } from '../../cases/src/entities.js';
import { TypeOrmIncidentClosures, closureFrom, closureRow } from './closures.js';
import {
  createIncidentWorkflowMigrationDataSource,
  runIncidentWorkflowMigrations,
} from './data-source.js';
import {
  INCIDENT_WORKFLOW_ENTITIES,
  INCIDENT_WORKFLOW_TABLES,
  IncidentClosureSchema,
} from './entities.js';
import {
  CreateIncidentClosures2026101600010,
  INCIDENT_WORKFLOW_MIGRATIONS_TABLE,
  INCIDENT_WORKFLOW_MIGRATION_VERSION,
} from './migrations.js';

const CLOSURE: IncidentClosure = {
  tenantId: 'tenant-a',
  incidentId: 'incident-1',
  cycle: 2,
  statusBefore: 'resolved',
  resolvedFrom: 'repair',
  resolvedAt: '2026-10-13T17:00:00.123Z',
  resolutionSummary: 'Resuelto',
  totalLoss: false,
  vehicleStatusDecision: 'active',
  insurerResult: 'partial',
  costAssumed: true,
  closeApprovedBy: 'user-1',
  closeApprovedAt: '2026-10-13T17:30:00.000Z',
  orders: [{ orderId: 'order-1', version: 4, status: 'closed' }],
  closedAt: '2026-10-13T18:00:00.456Z',
  closedBy: 'user-2',
};
const endpoint = { host: '127.0.0.1', port: 3306, database: 'opslog_t_x', password: 'x' };

describe('incident closures schema (migration after the cases)', () => {
  it('creates one table keyed by cycle, with checks and only the incident referenced', async () => {
    const statements: string[] = [];
    const runner = {
      query: async (sql: string) => void statements.push(sql),
      dropTable: async (name: string) => void statements.push(`DROP ${name}`),
    } as unknown as QueryRunner;
    const migration = new CreateIncidentClosures2026101600010();
    await migration.up(runner);
    const [sql] = statements as [string];
    expect(statements).toHaveLength(1);
    expect(sql).toContain('PRIMARY KEY (company_id,incident_id,cycle)');
    expect(sql).toContain("status_before IN ('resolved')");
    expect(sql).toContain(
      "'under_review','insurance_process','insurance_rejected','no_insurance','repair'",
    );
    expect(sql).toContain('(close_approved_by IS NULL) = (close_approved_at IS NULL)');
    expect(sql.match(/REFERENCES `([a-z_]+)`/g)).toEqual([
      `REFERENCES \`${INCIDENT_TABLES.incidents}\``,
    ]);
    expect(sql).toContain('COLLATE=utf8mb4_0900_bin');
    await migration.down(runner);
    expect(statements.at(-1)).toBe(`DROP ${INCIDENT_WORKFLOW_TABLES.closures}`);
    expect(INCIDENT_WORKFLOW_ENTITIES).toHaveLength(Object.keys(INCIDENT_WORKFLOW_TABLES).length);
    expect(INCIDENT_WORKFLOW_MIGRATION_VERSION).toBe('2026101600010');
  });

  it('has its own migrations table and refuses automatic synchronization', async () => {
    const source = createIncidentWorkflowMigrationDataSource({ ...endpoint, username: 'owner' });
    expect(source.options.migrationsTableName).toBe(INCIDENT_WORKFLOW_MIGRATIONS_TABLE);
    expect(source.options.migrations).toEqual([CreateIncidentClosures2026101600010]);
    expect(INCIDENT_WORKFLOW_MIGRATIONS_TABLE).not.toBe('opslog_incident_migrations');
    const unsafe = { options: { synchronize: true } } as unknown as DataSource;
    await expect(runIncidentWorkflowMigrations(unsafe)).rejects.toThrow(/forbidden/);
    const startup = { options: { migrationsRun: true } } as unknown as DataSource;
    await expect(runIncidentWorkflowMigrations(startup)).rejects.toThrow(/forbidden/);
    const ran: unknown[] = [];
    await runIncidentWorkflowMigrations({
      options: {},
      runMigrations: async (options: unknown) => void ran.push(options),
    } as unknown as DataSource);
    expect(ran).toEqual([{ transaction: 'all' }]);
  });

  it('registers the entity in the incidents data source', () => {
    const source = createIncidentDataSource({
      ...endpoint,
      username: 'opslog_incidents_abc',
    });
    expect(source.options.entities).toEqual(expect.arrayContaining([IncidentClosureSchema]));
  });

  it('maps rows without loss, with booleans as 0/1 and JSON as text', () => {
    expect(closureFrom(closureRow(CLOSURE))).toEqual(CLOSURE);
    const bare: IncidentClosure = {
      ...CLOSURE,
      resolvedAt: null,
      totalLoss: null,
      costAssumed: null,
      closeApprovedBy: null,
      closeApprovedAt: null,
      insurerResult: null,
      orders: [],
    };
    expect(closureFrom(closureRow(bare))).toEqual(bare);
    const driver = {
      ...closureRow(CLOSURE),
      totalLoss: 0,
      costAssumed: 1,
      orders: JSON.stringify(CLOSURE.orders),
    };
    expect(closureFrom(driver as never)).toMatchObject({
      totalLoss: false,
      costAssumed: true,
      orders: CLOSURE.orders,
    });
    expect(Object.keys(IncidentClosureSchema.options.columns).sort()).toEqual(
      Object.keys(closureRow(CLOSURE)).sort(),
    );
  });

  it('records in the transaction it is given, and tells a taken cycle from a failure', async () => {
    const inserted: unknown[] = [];
    let code: string | null = null;
    const manager = {
      getRepository: () => ({
        insert: async (row: unknown) => {
          if (code) throw Object.assign(new Error('boom'), { code });
          inserted.push(row);
        },
      }),
    } as unknown as EntityManager;
    const closures = new TypeOrmIncidentClosures({} as DataSource);
    expect(await closures.record(CLOSURE, manager)).toBe(true);
    expect(inserted).toHaveLength(1);
    code = 'ER_DUP_ENTRY';
    expect(await closures.record(CLOSURE, manager)).toBe(false);
    code = 'ER_LOCK_DEADLOCK';
    await expect(closures.record(CLOSURE, manager)).rejects.toThrow('boom');
  });
});
