import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { AUDIT_TABLES } from '../../../audit/src/index.js';
import { INCIDENT_TABLES } from '../../cases/src/entities.js';
import {
  adminUrl,
  startIncidentDatabase,
  type IncidentTestDatabase,
} from '../../cases/src/test-support/mysql.js';
import {
  createIncidentCostsMigrationDataSource,
  runIncidentCostsMigrations,
} from '../../costs/src/data-source.js';
import { DRAFT, MANAGER, Shared, incidentWorld } from '../../costs/src/test-support/world.js';
import {
  createIncidentWorkflowMigrationDataSource,
  runIncidentWorkflowMigrations,
} from '../../workflow/src/data-source.js';
import {
  createIncidentRepairsMigrationDataSource,
  runIncidentRepairsMigrations,
} from './data-source.js';
import { INCIDENT_REPAIR_TABLES as R } from './entities.js';

const suite = adminUrl ? describe : describe.skip;

suite('incident repair links on disposable MySQL 8.4', () => {
  let db: IncidentTestDatabase;
  let sourceA: DataSource;
  let sourceA2: DataSource;
  let sourceB: DataSource;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const shared = new Shared();
  let n = 0;
  const key = () => `key-links-mysql-${String((n += 1)).padStart(6, '0')}`;
  const world = (source: DataSource) => incidentWorld(source, shared);
  const order = (tenant = tenantA) => {
    const id = `order-${randomUUID()}`;
    shared.orders.add(id, { description: 'Descripción de orden sintética' }, tenant);
    return id;
  };
  const count = async (table: string, column: string, tenant: string, extra = '1=1') => {
    const [row] = await db.rows<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${table} WHERE ${column}=? AND ${extra}`,
      [tenant],
    );
    return Number(row?.n);
  };
  async function underReview(w: ReturnType<typeof world>, tenant = tenantA) {
    const created = await w.incidents.create(tenant, MANAGER, DRAFT);
    const run = (current: { id: string; version: number }, command: string, extra = {}) =>
      w.workflow.execute(tenant, MANAGER, current.id, {
        command,
        version: current.version,
        ...extra,
      });
    let current = await run(created, 'report');
    current = await run(current, 'assign', { responsibleId: MANAGER.subject });
    return run(current, 'review');
  }

  beforeAll(async () => {
    db = await startIncidentDatabase('links', {
      migrate: async (owner) => {
        for (const [create, run] of [
          [createIncidentWorkflowMigrationDataSource, runIncidentWorkflowMigrations],
          [createIncidentRepairsMigrationDataSource, runIncidentRepairsMigrations],
          [createIncidentCostsMigrationDataSource, runIncidentCostsMigrations],
        ] as const) {
          const source = create(owner);
          await source.initialize();
          try {
            await run(source);
          } finally {
            await source.destroy();
          }
        }
      },
      grants: [{ table: R.links, privileges: 'SELECT, INSERT, DELETE' }],
    });
    sourceA = await db.openIncidents('a');
    sourceA2 = await db.openIncidents('a');
    sourceB = await db.openIncidents('b');
  }, 180_000);
  afterAll(async () => {
    await db?.close();
  }, 60_000);

  it('links and unlinks with one version bump each, an event and a timeline entry, and no order data', async () => {
    const w = world(sourceA);
    const incident = await underReview(w);
    const orderId = order();
    const linked = await w.links.link(
      tenantA,
      MANAGER,
      incident.id,
      { version: incident.version, orderId },
      key(),
    );
    expect(linked.incident.version).toBe(incident.version + 1);
    expect((await w.links.list(tenantA, MANAGER, incident.id)).map((l) => l.orderId)).toEqual([
      orderId,
    ]);
    const history = await w.store.history(tenantA, incident.id);
    expect(history.at(-1)).toMatchObject({ command: 'repair_linked' });
    const unlinked = await w.links.unlink(
      tenantA,
      MANAGER,
      incident.id,
      linked.link.id,
      { version: linked.incident.version },
      key(),
    );
    expect(unlinked.version).toBe(linked.incident.version + 1);
    expect((await w.store.history(tenantA, incident.id)).at(-1)).toMatchObject({
      command: 'repair_unlinked',
    });
    const events = await db.rows<{ type: string; payload: Record<string, unknown> }>(
      `SELECT type, payload FROM ${AUDIT_TABLES.outbox} WHERE tenant_id=? AND entity_id=? AND type LIKE 'incident.repair_%'`,
      [tenantA, incident.id],
    );
    expect(events.map((e) => e.type).sort()).toEqual([
      'incident.repair_linked',
      'incident.repair_unlinked',
    ]);
    for (const event of events)
      expect(Object.keys(event.payload).sort().join()).toBe('incidentId,orderId,version');
    const dump = JSON.stringify([
      await db.rows(`SELECT * FROM ${INCIDENT_TABLES.transitions}`),
      await db.rows(`SELECT * FROM ${AUDIT_TABLES.local}`),
      await db.rows(`SELECT * FROM ${AUDIT_TABLES.outbox}`),
    ]);
    expect(dump).not.toContain('Descripción de orden sintética');
    expect(await count(R.links, 'company_id', tenantA, `incident_id='${incident.id}'`)).toBe(0);
  });

  it('two connections racing for the same order: one link, the other is a duplicate, nothing half done (case 11)', async () => {
    const w = world(sourceA);
    const w2 = world(sourceA2);
    const first = await underReview(w);
    const second = await underReview(w);
    const orderId = order();
    const results = await Promise.allSettled([
      w.links.link(tenantA, MANAGER, first.id, { version: first.version, orderId }, key()),
      w2.links.link(tenantA, MANAGER, second.id, { version: second.version, orderId }, key()),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      (results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason,
    ).toMatchObject({
      code: 'duplicate',
    });
    expect(await count(R.links, 'company_id', tenantA, `order_id='${orderId}'`)).toBe(1);
    const loserId = results[0]?.status === 'rejected' ? first.id : second.id;
    const [row] = await db.rows<{ version: number }>(
      `SELECT version FROM ${INCIDENT_TABLES.incidents} WHERE company_id=? AND id=?`,
      [tenantA, loserId],
    );
    expect(row?.version).toBe(first.version);
  });

  it('isolates tenants: a foreign order or case reads as absent, and the same id in B is another order (case 9)', async () => {
    const w = world(sourceA);
    const incident = await underReview(w);
    const foreign = order(tenantB);
    await expect(
      w.links.link(
        tenantA,
        MANAGER,
        incident.id,
        { version: incident.version, orderId: foreign },
        key(),
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(world(sourceB).links.list(tenantA, MANAGER, incident.id)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(await db.rowsB(`SELECT 1 FROM ${R.links}`)).toEqual([]);
    const shared1 = `order-${randomUUID()}`;
    shared.orders.add(shared1, {}, tenantA);
    shared.orders.add(shared1, {}, tenantB);
    const other = await underReview(world(sourceB), tenantB);
    await w.links.link(
      tenantA,
      MANAGER,
      incident.id,
      { version: incident.version, orderId: shared1 },
      key(),
    );
    await world(sourceB).links.link(
      tenantB,
      MANAGER,
      other.id,
      { version: other.version, orderId: shared1 },
      key(),
    );
    expect(await count(R.links, 'company_id', tenantA, `order_id='${shared1}'`)).toBe(1);
  });

  it('the runtime account can only insert, read and delete links', async () => {
    const w = world(sourceA);
    const incident = await underReview(w);
    await w.links.link(
      tenantA,
      MANAGER,
      incident.id,
      { version: incident.version, orderId: order() },
      key(),
    );
    for (const sql of [
      `UPDATE ${R.links} SET order_id='x'`,
      `DROP TABLE ${R.links}`,
      `TRUNCATE ${R.links}`,
    ])
      await expect(sourceA.query(sql), sql).rejects.toBeDefined();
    await expect(
      sourceA.query(
        `INSERT INTO ${R.links} (company_id,incident_id,id,order_id,linked_at,linked_by) VALUES (?,'missing','x','o',NOW(6),'u')`,
        [tenantA],
      ),
    ).rejects.toBeDefined();
  });

  for (const routine of [
    'opslog_enqueue_tenant_outbox',
    'opslog_append_local_audit_and_delivery',
  ]) {
    it(`leaves no link behind when ${routine} fails (case 13)`, async () => {
      const w = world(sourceA);
      const incident = await underReview(w);
      const orderId = order();
      await db.rows(
        `REVOKE EXECUTE ON PROCEDURE \`${db.databaseName}\`.\`${routine}\` FROM '${db.runtimeUserA}'@'%'`,
      );
      try {
        await expect(
          w.links.link(
            tenantA,
            MANAGER,
            incident.id,
            { version: incident.version, orderId },
            key(),
          ),
        ).rejects.toBeDefined();
      } finally {
        await db.rows(
          `GRANT EXECUTE ON PROCEDURE \`${db.databaseName}\`.\`${routine}\` TO '${db.runtimeUserA}'@'%'`,
        );
      }
      expect(await count(R.links, 'company_id', tenantA, `order_id='${orderId}'`)).toBe(0);
      const retry = await w.links.link(
        tenantA,
        MANAGER,
        incident.id,
        { version: incident.version, orderId },
        key(),
      );
      expect(retry.incident.version).toBe(incident.version + 1);
    });
  }
});
