import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { QueryRunner } from 'typeorm';
import { createWorkOrderDataSource, createWorkOrderMigrationDataSource } from './data-source.js';
import { WORK_ORDER_ENTITIES, WORK_ORDER_TABLES } from './entities.js';
import {
  CreateMaintenanceWorkOrderFiles2026101300020,
  AddMaintenanceWorkOrderClosureIndex2026101900010,
  CreateMaintenanceWorkOrderIdempotency2026101400010,
  CreateMaintenanceWorkOrders2026101200030,
} from './migrations.js';
import { TypeOrmWorkOrderStore } from './store.js';
import {
  childRows,
  fileFrom,
  fileRow,
  idempotencyFrom,
  idempotencyRow,
  orderFrom,
  orderRow,
  transitionFrom,
  transitionRow,
} from './mapping.js';
import { harness, FLEET, TENANT } from '../../../../domain/maintenance/orders/src/test-support.js';

const endpoint = { host: '127.0.0.1', port: 3306, database: 'opslog_t_x', password: 'x' };

describe('work order schema', () => {
  it('keys every table by tenant without cross-module foreign keys', async () => {
    const statements: string[] = [];
    const runner = {
      query: async (sql: string) => void statements.push(sql),
      dropTable: async (name: string) => void statements.push(`DROP ${name}`),
    } as unknown as QueryRunner;
    const migration = new CreateMaintenanceWorkOrders2026101200030();
    await migration.up(runner);
    expect(statements).toHaveLength(Object.keys(WORK_ORDER_TABLES).length - 2);
    for (const sql of statements) {
      expect(sql).toMatch(/PRIMARY KEY \(company_id,/);
      expect(sql).toContain('ENGINE=InnoDB');
    }
    expect(statements[0]).toContain(
      'UNIQUE KEY uq_work_order_occurrence (company_id,occurrence_id)',
    );
    expect(statements.join(' ')).not.toMatch(/opslog_maintenance_(workshops|mechanics|plans)/);
    await migration.down(runner);
    expect(statements.slice(-5)).toEqual([
      `DROP ${WORK_ORDER_TABLES.transitions}`,
      `DROP ${WORK_ORDER_TABLES.costs}`,
      `DROP ${WORK_ORDER_TABLES.parts}`,
      `DROP ${WORK_ORDER_TABLES.tasks}`,
      `DROP ${WORK_ORDER_TABLES.orders}`,
    ]);
    expect(WORK_ORDER_ENTITIES).toHaveLength(Object.keys(WORK_ORDER_TABLES).length);
  });

  it('creates the evidence links keyed by tenant, unique per file, and reverts them', async () => {
    const statements: string[] = [];
    const runner = {
      query: async (sql: string) => void statements.push(sql),
      dropTable: async (name: string) => void statements.push(`DROP ${name}`),
    } as unknown as QueryRunner;
    const migration = new CreateMaintenanceWorkOrderFiles2026101300020();
    await migration.up(runner);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('PRIMARY KEY (company_id,order_id,id)');
    expect(statements[0]).toContain('UNIQUE KEY uq_work_order_file (company_id,file_id)');
    expect(statements[0]).toContain("CHECK (kind IN ('evidence','invoice'))");
    expect(statements[0]).not.toMatch(/sha256|storage/i);
    await migration.down(runner);
    expect(statements.at(-1)).toBe(`DROP ${WORK_ORDER_TABLES.files}`);
  });

  it('creates the idempotency registry keyed by tenant, actor, command and key, and reverts it', async () => {
    const statements: string[] = [];
    const runner = {
      query: async (sql: string) => void statements.push(sql),
      dropTable: async (name: string) => void statements.push(`DROP ${name}`),
    } as unknown as QueryRunner;
    const migration = new CreateMaintenanceWorkOrderIdempotency2026101400010();
    await migration.up(runner);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('PRIMARY KEY (company_id,actor_id,command,idempotency_key)');
    expect(statements[0]).toContain('payload_hash CHAR(64)');
    expect(statements[0]).toContain('response JSON NOT NULL');
    expect(statements[0]).toContain('expires_at DATETIME(6) NOT NULL');
    expect(statements[0]).toContain("CHECK (status = 'completed')");
    await migration.down(runner);
    expect(statements.at(-1)).toBe(`DROP ${WORK_ORDER_TABLES.idempotency}`);
  });

  it('adds the closure index for dashboard reads and reverts it', async () => {
    const statements: string[] = [];
    const runner = {
      query: async (sql: string) => void statements.push(sql),
    } as unknown as QueryRunner;
    const migration = new AddMaintenanceWorkOrderClosureIndex2026101900010();
    await migration.up(runner);
    expect(statements[0]).toContain('ix_work_order_closure');
    expect(statements[0]).toContain('(company_id,status,closed_at)');
    await migration.down(runner);
    expect(statements.at(-1)).toContain('DROP INDEX ix_work_order_closure');
  });

  it('maps idempotency records without loss, from a JSON value or from text', () => {
    const order = { id: 'order-1', tenantId: TENANT, version: 7, status: 'closed' };
    const claim = {
      actorId: 'user-admin',
      command: 'close' as const,
      key: 'close-key-0001',
      orderId: 'order-1',
      payloadHash: 'a'.repeat(64),
      createdAt: '2026-10-12T12:00:00.123Z',
      expiresAt: '2026-10-13T12:00:00.123Z',
    };
    const row = idempotencyRow(TENANT, claim, order as never);
    const record = { ...claim, tenantId: TENANT, status: 'completed', response: order };
    expect(idempotencyFrom(row)).toEqual(record);
    expect(
      idempotencyFrom({ ...row, response: JSON.stringify(order) as unknown as object }),
    ).toEqual(record);
  });

  it('maps evidence links without loss', () => {
    const link = {
      id: 'link-1',
      tenantId: TENANT,
      orderId: 'order-1',
      fileId: 'file-1',
      kind: 'invoice' as const,
      displayName: 'factura.pdf',
      contentType: 'application/pdf',
      sizeBytes: 2048,
      attachedBy: 'user-fleet',
      attachedAt: '2026-10-13T10:00:00.123Z',
    };
    expect(fileFrom({ ...fileRow(link), sizeBytes: '2048' })).toEqual(link);
  });

  it('only runs with the restricted maintenance account and never synchronizes', () => {
    expect(() => createWorkOrderDataSource({ ...endpoint, username: 'root' })).toThrow();
    const source = createWorkOrderDataSource({ ...endpoint, username: 'opslog_maintenance_abc' });
    expect(source.options).toMatchObject({ synchronize: false, migrationsRun: false });
    expect(() => new TypeOrmWorkOrderStore(source)).not.toThrow();
    const migrator = createWorkOrderMigrationDataSource({ ...endpoint, username: 'owner' });
    expect(() => new TypeOrmWorkOrderStore(migrator)).toThrow();
  });

  it('maps orders and timeline rows without loss', async () => {
    const h = harness();
    const order = await h.service.createCorrective(TENANT, FLEET, {
      vehicleId: 'vehicle-1',
      description: 'x',
    });
    const assigned = await h.service.assign(TENANT, FLEET, order.id, {
      version: 1,
      responsibleId: 'fleet',
      workshopId: 'workshop-1',
      scheduledDate: '2026-10-13',
    });
    const started = await h.service.start(TENANT, FLEET, order.id, { version: assigned.version });
    const worked = await h.service.updateWork(TENANT, FLEET, order.id, {
      version: started.version,
      tasks: [{ description: 't' }],
      parts: [{ name: 'p', quantity: '2' }],
    });
    const costed = await h.service.updateCosts(TENANT, FLEET, order.id, {
      version: worked.version,
      costs: [{ category: 'other', amount: { amountMinor: '10', currency: 'MXN' } }],
      partCosts: [{ partId: worked.parts[0]?.id, unitCost: { amountMinor: '7', currency: 'MXN' } }],
    });
    const children = childRows(costed);
    const rows = {
      tasks: children.tasks,
      parts: children.parts.map((part) => ({ ...part, quantity: `${part.quantity}.000` })),
      costs: children.costs,
    };
    const row = orderRow(costed);
    expect(orderFrom(row, rows.tasks, rows.parts, rows.costs)).toEqual(costed);
    for (const transition of await h.store.history(TENANT, order.id))
      expect(transitionFrom(transitionRow(transition))).toEqual(transition);
  });
});
