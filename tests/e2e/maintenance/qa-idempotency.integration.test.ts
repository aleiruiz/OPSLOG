import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { AUDIT_TABLES } from '../../../packages/persistence/audit/src/index.js';
import { WORK_ORDER_TABLES } from '../../../packages/persistence/maintenance/orders/src/index.js';
import type {
  WorkOrder,
  WorkOrderService,
} from '../../../packages/domain/maintenance/orders/src/index.js';
import {
  ACTORS,
  VEHICLE,
  adminUrl,
  startMaintenanceWorld,
  type MaintenanceWorld,
} from './qa-world.js';

const suite = adminUrl ? describe : describe.skip;
const code = async (work: Promise<unknown>) =>
  work.then(
    () => 'ok',
    (error: { code?: string }) => String(error.code),
  );

// MNT-QA-M3-20261011:62 / G3 H2 (SPECS:195): repeated close and reopen requests with the same
// Idempotency-Key return a stable result and a conflicting payload is rejected, on real MySQL 8.4.
suite('work order idempotency acceptance on MySQL 8.4', () => {
  let world: MaintenanceWorld;
  beforeAll(async () => {
    world = await startMaintenanceWorld('qa_idem');
  }, 180_000);
  afterAll(async () => {
    await world?.close();
  }, 60_000);

  async function completed(
    service: WorkOrderService,
    tenantId = world.tenantA,
    mechanicId = 'mechanic-a',
  ): Promise<WorkOrder> {
    const mechanic = { ...world.mechanic, mechanicIds: [mechanicId] };
    let order = await service.createCorrective(tenantId, ACTORS.editor, {
      vehicleId: VEHICLE,
      description: 'Idempotencia sintética',
    });
    order = await service.assign(tenantId, ACTORS.editor, order.id, {
      version: order.version,
      responsibleId: 'editor',
      workshopId: 'workshop-1',
      mechanicId,
      scheduledDate: '2026-10-12',
    });
    order = await service.start(tenantId, mechanic, order.id, { version: order.version });
    order = await service.updateWork(tenantId, mechanic, order.id, {
      version: order.version,
      tasks: [{ description: 'Diagnóstico y reparación' }],
    });
    order = await service.updateCosts(tenantId, ACTORS.admin, order.id, {
      version: order.version,
      costs: [{ category: 'labor', amount: { amountMinor: '250000', currency: 'MXN' } }],
    });
    return service.complete(tenantId, mechanic, order.id, {
      version: order.version,
      actualDate: '2026-10-12',
      actualKm: 1200,
    });
  }
  const close = (version: number, extra: object = {}) => ({
    version,
    vehicleStatus: 'restricted',
    ...extra,
  });
  const count = async (sql: string, params: unknown[]) =>
    Number((await world.db.rows<{ total: number }>(sql, params))[0]?.total);

  it('requires the key to close and reopen and replays the same close and reopen results', async () => {
    const service = world.service();
    const t = world.tenantA;
    const done = await completed(service);
    const closeKey = `close-${randomUUID()}`;
    const reopenKey = `reopen-${randomUUID()}`;
    expect(
      await code(service.execute(t, ACTORS.admin, 'close', done.id, close(done.version))),
    ).toBe('idempotency_key_required');
    const closed = await service.execute(
      t,
      ACTORS.admin,
      'close',
      done.id,
      close(done.version),
      closeKey,
    );
    expect(
      await service.execute(t, ACTORS.admin, 'close', done.id, close(done.version), closeKey),
    ).toEqual(closed);
    const reopened = await service.execute(
      t,
      ACTORS.admin,
      'reopen',
      done.id,
      { version: closed.version, reason: 'Falta factura' },
      reopenKey,
    );
    expect(
      await service.execute(
        t,
        ACTORS.admin,
        'reopen',
        done.id,
        { reason: 'Falta factura', version: closed.version },
        reopenKey,
      ),
    ).toEqual(reopened);
    // Replays never execute again: one close and one reopen in the timeline, one outbox row per version.
    const commands = await world.db.rows<{ command: string }>(
      `SELECT command FROM ${WORK_ORDER_TABLES.transitions} WHERE company_id=? AND order_id=? AND command IN ('close','reopen')`,
      [t, done.id],
    );
    expect(commands.map((c) => c.command)).toEqual(['close', 'reopen']);
    expect(
      await count(
        `SELECT COUNT(*) AS total FROM ${AUDIT_TABLES.outbox} WHERE tenant_id=? AND entity_id=? AND type='maintenance.status_changed'`,
        [t, done.id],
      ),
    ).toBe(5); // assign, start, complete, close, reopen: replays added none
    expect((await service.get(t, ACTORS.admin, done.id)).status).toBe('in_progress');
  });

  it('rejects the same key with another payload and keeps the order untouched', async () => {
    const service = world.service();
    const t = world.tenantA;
    const done = await completed(service);
    const key = `close-${randomUUID()}`;
    const closed = await service.execute(
      t,
      ACTORS.admin,
      'close',
      done.id,
      close(done.version),
      key,
    );
    expect(
      await code(
        service.execute(
          t,
          ACTORS.admin,
          'close',
          done.id,
          close(done.version, { comment: 'otro' }),
          key,
        ),
      ),
    ).toBe('idempotency_conflict');
    expect((await service.get(t, ACTORS.admin, done.id)).version).toBe(closed.version);
  });

  it('collapses concurrent duplicates from different nodes into one effect', async () => {
    const t = world.tenantA;
    const nodes = [world.service({ side: 'a' }), world.service({ side: 'a2' })];
    const done = await completed(nodes[0] as WorkOrderService);
    const key = `close-${randomUUID()}`;
    const results = await Promise.all(
      [0, 1, 0, 1].map((n) =>
        (nodes[n] as WorkOrderService).execute(
          t,
          ACTORS.admin,
          'close',
          done.id,
          close(done.version),
          key,
        ),
      ),
    );
    expect(new Set(results.map((r) => r.version))).toEqual(new Set([done.version + 1]));
    expect(
      await count(
        `SELECT COUNT(*) AS total FROM ${AUDIT_TABLES.outbox} WHERE tenant_id=? AND entity_id=? AND type='maintenance.status_changed' AND JSON_EXTRACT(payload,'$.version')=?`,
        [t, done.id, done.version + 1],
      ),
    ).toBe(1);
  });

  it('scopes keys to the actor and to the tenant database', async () => {
    const key = `close-${randomUUID()}`;
    const a = world.service();
    const b = world.service({ side: 'b' });
    const doneA = await completed(a);
    const doneB = await completed(b, world.tenantB, 'mechanic-b');
    await a.execute(world.tenantA, ACTORS.admin, 'close', doneA.id, close(doneA.version), key);
    // Same actor id and key text in tenant B is an independent command.
    const closedB = await b.execute(
      world.tenantB,
      ACTORS.admin,
      'close',
      doneB.id,
      close(doneB.version),
      key,
    );
    expect(closedB.status).toBe('closed');
    // Tenant A's key does not reveal or replay tenant B's order, and another actor never replays it.
    expect(
      await code(
        a.execute(world.tenantA, ACTORS.admin, 'close', doneB.id, close(doneB.version), key),
      ),
    ).toBe('idempotency_conflict');
    expect(await code(b.get(world.tenantB, ACTORS.editor, doneA.id))).toBe('not_found');
    expect(
      await code(
        a.execute(
          world.tenantA,
          { ...ACTORS.admin, id: 'user-admin-2' },
          'close',
          doneA.id,
          close(doneA.version),
          key,
        ),
      ),
    ).toBe('invalid_transition');
  });
});
