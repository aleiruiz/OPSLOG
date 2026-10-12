import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { QueryRunner } from 'typeorm';
import { createWorkOrderDataSource, createWorkOrderMigrationDataSource } from './data-source.js';
import { WORK_ORDER_ENTITIES, WORK_ORDER_TABLES } from './entities.js';
import { CreateMaintenanceWorkOrders2026101200030 } from './migrations.js';
import { TypeOrmWorkOrderStore } from './store.js';
import { childRows, orderFrom, orderRow, transitionFrom, transitionRow } from './mapping.js';
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
    expect(statements).toHaveLength(Object.keys(WORK_ORDER_TABLES).length);
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
    expect(WORK_ORDER_ENTITIES).toHaveLength(5);
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
