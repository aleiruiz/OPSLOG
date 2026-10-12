import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { TypeOrmMaintenancePlanStore } from './store.js';
import { MAINTENANCE_TABLES } from './entities.js';
import {
  adminUrl,
  startMaintenanceDatabase,
  type MaintenanceTestDatabase,
} from './test-support/mysql.js';
import type { MaintenancePlan } from '../../../../domain/maintenance/plans/src/index.js';

const suite = adminUrl ? describe : describe.skip;
const now = new Date('2026-10-12T12:00:00.000Z');
const plan = (tenantId: string, id: string): MaintenancePlan => ({
  tenantId,
  id,
  vehicleId: 'synthetic-vehicle',
  state: 'active',
  intervalDays: 30,
  lastServiceDate: '2026-09-12',
  version: 1,
  createdAt: now.toISOString(),
  updatedAt: now.toISOString(),
});

suite('maintenance persistence on disposable MySQL 8.4', () => {
  let db: MaintenanceTestDatabase;
  let sourceA: DataSource;
  let sourceA2: DataSource;
  let sourceB: DataSource;
  let storeA: TypeOrmMaintenancePlanStore;
  let storeA2: TypeOrmMaintenancePlanStore;
  let storeB: TypeOrmMaintenancePlanStore;

  beforeAll(async () => {
    db = await startMaintenanceDatabase('plans');
    sourceA = await db.openRuntime();
    sourceA2 = await db.openRuntime('a');
    sourceB = await db.openRuntime('b');
    storeA = new TypeOrmMaintenancePlanStore(sourceA);
    storeA2 = new TypeOrmMaintenancePlanStore(sourceA2);
    storeB = new TypeOrmMaintenancePlanStore(sourceB);
  }, 120_000);
  afterAll(async () => {
    await db?.close();
  }, 60_000);

  it('migrates owned tables, isolates tenants, serializes two scanners, and emits a single due alert/order', async () => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const value = plan(tenantA, randomUUID());
    await storeA.create(value, 'synthetic-actor');
    await storeB.create(plan(tenantB, value.id), 'synthetic-actor');
    expect(await storeB.get(tenantB, value.id)).toMatchObject({ tenantId: tenantB, id: value.id });
    await expect(
      sourceA.query(`SELECT id FROM \`${db.tenantDatabaseName}\`.\`${MAINTENANCE_TABLES.plans}\``),
    ).rejects.toBeDefined();
    expect(await storeA.get(tenantB, value.id)).toBeNull();
    await expect(
      storeB.scan(tenantB, randomUUID(), now, { km: 0, updatedAt: now.toISOString() }),
    ).rejects.toMatchObject({ code: 'not_found' });

    const results = await Promise.all([
      storeA.scan(tenantA, value.id, now, { km: 0, updatedAt: now.toISOString() }),
      storeA2.scan(tenantA, value.id, now, { km: 0, updatedAt: now.toISOString() }),
    ]);
    expect(results.flat().filter((alert) => alert.kind === 'due')).toHaveLength(1);
    expect(
      await storeA.scan(tenantA, value.id, now, { km: 0, updatedAt: now.toISOString() }),
    ).toEqual([]);
    const [occurrences] = await db.rows<{ count: number }>(
      `SELECT COUNT(*) AS count FROM ${MAINTENANCE_TABLES.occurrences} WHERE company_id=?`,
      [tenantA],
    );
    const [orders] = await db.rows<{ count: number }>(
      `SELECT COUNT(*) AS count FROM ${MAINTENANCE_TABLES.orders} WHERE company_id=?`,
      [tenantA],
    );
    const [alerts] = await db.rows<{ count: number }>(
      `SELECT COUNT(*) AS count FROM ${MAINTENANCE_TABLES.alerts} WHERE company_id=? AND kind='due'`,
      [tenantA],
    );
    expect(Number(occurrences?.count)).toBe(1);
    expect(Number(orders?.count)).toBe(1);
    expect(Number(alerts?.count)).toBe(1);
    expect(await storeA.readSchedule(tenantA, value.id)).toMatchObject({
      planId: value.id,
      nextTargetDate: '2026-10-12',
      occurrence: { sequence: 1, state: 'scheduled' },
      order: { status: 'scheduled', kind: 'preventive' },
    });
    expect(await storeA.listScheduledOrders(tenantA, value.id)).toHaveLength(1);
  });

  it('commits overdue once while incomplete and advances only on an idempotent closure', async () => {
    const tenant = randomUUID();
    const value = plan(tenant, randomUUID());
    await storeA.create(value, 'synthetic-actor');
    const firstPastTarget = new Date('2026-10-13T00:00:00.000Z');
    const first = await storeA.scan(tenant, value.id, firstPastTarget, {
      km: 0,
      updatedAt: now.toISOString(),
    });
    expect(first.map((item) => item.kind)).toEqual(['due', 'overdue']);
    const repeated = await storeA2.scan(tenant, value.id, new Date('2026-10-14T00:00:00.000Z'), {
      km: 0,
      updatedAt: now.toISOString(),
    });
    expect(repeated.map((item) => item.kind)).toEqual(['overdue']);
    const [overdues] = await db.rows<{ count: number }>(
      `SELECT COUNT(*) AS count FROM ${MAINTENANCE_TABLES.alerts} WHERE company_id=? AND kind='overdue'`,
      [tenant],
    );
    expect(Number(overdues?.count)).toBe(1);
    const [occurrence] = await db.rows<{ id: string; order_id: string }>(
      `SELECT id, order_id FROM ${MAINTENANCE_TABLES.occurrences} WHERE company_id=?`,
      [tenant],
    );
    await storeA.closePreventive({
      tenantId: tenant,
      planId: value.id,
      occurrenceId: occurrence!.id,
      orderId: occurrence!.order_id,
      kind: 'preventive',
      eventId: randomUUID(),
      completedAt: '2026-10-14T01:00:00.000Z',
      actualDate: '2026-10-14',
      actualKm: 1100,
    });
    await storeA2.closePreventive({
      tenantId: tenant,
      planId: value.id,
      occurrenceId: occurrence!.id,
      orderId: occurrence!.order_id,
      kind: 'preventive',
      eventId: randomUUID(),
      completedAt: '2026-10-14T01:00:00.000Z',
      actualDate: '2026-10-14',
      actualKm: 1100,
    });
    expect(await storeA.get(tenant, value.id)).toMatchObject({
      version: 2,
      lastServiceDate: '2026-10-14',
      lastServiceKm: 1100,
    });
    expect(await storeA.readSchedule(tenant, value.id)).toMatchObject({
      nextTargetDate: '2026-11-13',
      occurrence: { sequence: 1, state: 'completed' },
      order: { status: 'completed' },
    });
  });

  it('rolls back the business transaction when outbox or audit delivery is unavailable', async () => {
    const tenant = randomUUID();
    const value = plan(tenant, randomUUID());
    await db.admin.query(
      `REVOKE EXECUTE ON PROCEDURE \`${db.databaseName}\`.\`opslog_enqueue_tenant_outbox\` FROM '${db.runtimeUserA}'@'%'`,
    );
    try {
      await expect(
        storeA.scan(tenant, value.id, now, { km: 0, updatedAt: now.toISOString() }),
      ).rejects.toBeDefined();
    } finally {
      await db.admin.query(
        `GRANT EXECUTE ON PROCEDURE \`${db.databaseName}\`.\`opslog_enqueue_tenant_outbox\` TO '${db.runtimeUserA}'@'%'`,
      );
    }
    const [rolledBackScan] = await db.rows<{ count: number }>(
      `SELECT COUNT(*) AS count FROM ${MAINTENANCE_TABLES.plans} WHERE company_id=? AND id=?`,
      [tenant, value.id],
    );
    expect(Number(rolledBackScan?.count)).toBe(0);

    await db.admin.query(
      `REVOKE EXECUTE ON PROCEDURE \`${db.databaseName}\`.\`opslog_append_local_audit_and_delivery\` FROM '${db.runtimeUserA}'@'%'`,
    );
    try {
      await expect(storeA.create(value, 'synthetic-actor')).rejects.toBeDefined();
    } finally {
      await db.admin.query(
        `GRANT EXECUTE ON PROCEDURE \`${db.databaseName}\`.\`opslog_append_local_audit_and_delivery\` TO '${db.runtimeUserA}'@'%'`,
      );
    }
    const [rolledBackCreate] = await db.rows<{ count: number }>(
      `SELECT COUNT(*) AS count FROM ${MAINTENANCE_TABLES.plans} WHERE company_id=? AND id=?`,
      [tenant, value.id],
    );
    expect(Number(rolledBackCreate?.count)).toBe(0);
  });
});
