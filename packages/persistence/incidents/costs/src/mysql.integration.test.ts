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
  createIncidentRepairsMigrationDataSource,
  runIncidentRepairsMigrations,
} from '../../repairs/src/data-source.js';
import { INCIDENT_REPAIR_TABLES as R } from '../../repairs/src/entities.js';
import {
  createIncidentCostsMigrationDataSource,
  runIncidentCostsMigrations,
} from './data-source.js';
import { INCIDENT_COST_TABLES as T } from './entities.js';
import {
  createIncidentWorkflowMigrationDataSource,
  runIncidentWorkflowMigrations,
} from '../../workflow/src/data-source.js';
import { INCIDENT_WORKFLOW_TABLES as W } from '../../workflow/src/entities.js';
import { DRAFT, MANAGER, NO_COSTS, Shared, incidentWorld } from './test-support/world.js';

const suite = adminUrl ? describe : describe.skip;
const expense = (category: string, amountMinor: string, currency = 'MXN') => ({
  kind: 'expense',
  category,
  amount: { amountMinor, currency },
});
const recovery = (amountMinor: string) => ({
  kind: 'recovery',
  category: 'insurer',
  amount: { amountMinor, currency: 'MXN' },
});
const SECRET_NOTE = 'Nota sintética secreta';

suite('incident costs and repair links on disposable MySQL 8.4', () => {
  let db: IncidentTestDatabase;
  let sourceA: DataSource;
  let sourceA2: DataSource;
  let sourceB: DataSource;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const shared = new Shared();
  let n = 0;
  const key = () => `key-costs-mysql-${String((n += 1)).padStart(6, '0')}`;
  const world = (source: DataSource) => incidentWorld(source, shared);
  const migrate = async (owner: Parameters<typeof createIncidentRepairsMigrationDataSource>[0]) => {
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
  };
  const count = async (table: string, column: string, tenant: string, extra = '1=1') => {
    const [row] = await db.rows<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${table} WHERE ${column}=? AND ${extra}`,
      [tenant],
    );
    return Number(row?.n);
  };
  const snapshot = async (id: string) => ({
    lines: await count(T.lines, 'company_id', tenantA, `incident_id='${id}'`),
    estimates: await count(T.estimates, 'company_id', tenantA, `incident_id='${id}'`),
    links: await count(R.links, 'company_id', tenantA, `incident_id='${id}'`),
    transitions: await count(
      INCIDENT_TABLES.transitions,
      'company_id',
      tenantA,
      `incident_id='${id}'`,
    ),
    audit: await count(AUDIT_TABLES.local, 'tenant_id', tenantA, `entity_id='${id}'`),
    outbox: await count(AUDIT_TABLES.outbox, 'tenant_id', tenantA, `entity_id='${id}'`),
    version: (
      await db.rows<{ version: number }>(
        `SELECT version FROM ${INCIDENT_TABLES.incidents} WHERE company_id=? AND id=?`,
        [tenantA, id],
      )
    )[0]?.version,
  });

  /** A case taken by the commands to `under_review`, as a user would. */
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
  async function resolved(w: ReturnType<typeof world>, tenant = tenantA) {
    const current = await underReview(w, tenant);
    const updated = await w.process.updateResolution(tenant, MANAGER, current.id, {
      version: current.version,
      resolutionSummary: 'Resuelto de forma sintética',
      vehicleStatusDecision: 'restricted',
    });
    return w.workflow.execute(tenant, MANAGER, updated.id, {
      command: 'resolve',
      version: updated.version,
    });
  }
  const put = (
    w: ReturnType<typeof world>,
    incident: { id: string; version: number },
    body: Record<string, unknown>,
    tenant = tenantA,
    k = key(),
  ) =>
    w.costService.update(tenant, MANAGER, incident.id, { version: incident.version, ...body }, k);

  beforeAll(async () => {
    db = await startIncidentDatabase('costs', {
      migrate,
      grants: [
        { table: W.closures, privileges: 'SELECT, INSERT' },
        { table: R.links, privileges: 'SELECT, INSERT, DELETE' },
        { table: T.lines, privileges: 'SELECT, INSERT, DELETE' },
        { table: T.estimates, privileges: 'SELECT, INSERT, UPDATE, DELETE' },
        { table: T.snapshots, privileges: 'SELECT, INSERT' },
        { table: T.approvals, privileges: 'SELECT, INSERT, DELETE' },
      ],
    });
    sourceA = await db.openIncidents('a');
    sourceA2 = await db.openIncidents('a');
    sourceB = await db.openIncidents('b');
  }, 180_000);
  afterAll(async () => {
    await db?.close();
  }, 60_000);

  it('stores exact amounts, no amount or note in timeline, audit or outbox, and bumps the version once', async () => {
    const w = world(sourceA);
    const incident = await underReview(w);
    const saved = await put(w, incident, {
      lines: [{ ...expense('towing', '999999999999999'), note: SECRET_NOTE }, recovery('1')],
      initialEstimate: { amountMinor: '777', currency: 'USD' },
    });
    expect(saved.incident.version).toBe(incident.version + 1);
    expect(saved.costs.totals).toEqual([
      {
        currency: 'MXN',
        repairs: '0',
        expenses: '999999999999999',
        recoveries: '1',
        companyBorne: '999999999999998',
      },
    ]);
    const rows = await db.rows<Record<string, string | number>>(
      `SELECT amount_minor, currency, position FROM ${T.lines} WHERE company_id=? AND incident_id=? ORDER BY position`,
      [tenantA, incident.id],
    );
    expect(rows.map((r) => String(r.amount_minor))).toEqual(['999999999999999', '1']);
    const dump = JSON.stringify([
      await db.rows(`SELECT * FROM ${INCIDENT_TABLES.transitions}`),
      await db.rows(`SELECT * FROM ${AUDIT_TABLES.local}`),
      await db.rows(`SELECT * FROM ${AUDIT_TABLES.outbox}`),
    ]);
    for (const secret of [SECRET_NOTE, '999999999999999', '777'])
      expect(dump).not.toContain(secret);
    const events = await db.rows<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM ${AUDIT_TABLES.outbox} WHERE tenant_id=? AND entity_id=? AND type='incident.costs_changed'`,
      [tenantA, incident.id],
    );
    expect(events.map((e) => Object.keys(e.payload).sort().join())).toEqual(['incidentId,version']);
    // Another connection reads the same state; replacing the lines leaves no stale row.
    const again = await put(world(sourceA2), saved.incident, { lines: [expense('fine', '5')] });
    expect(again.costs.lines).toHaveLength(1);
    expect(await count(T.lines, 'company_id', tenantA, `incident_id='${incident.id}'`)).toBe(1);
    // An omitted estimate is kept; only an explicit null clears it.
    expect(await count(T.estimates, 'company_id', tenantA, `incident_id='${incident.id}'`)).toBe(1);
    await put(world(sourceA), again.incident, { lines: [], initialEstimate: null });
    expect(await count(T.estimates, 'company_id', tenantA, `incident_id='${incident.id}'`)).toBe(0);
  });

  it('hides amounts without view_costs and isolates tenants (cases 4 and 9)', async () => {
    const w = world(sourceA);
    const incident = await underReview(w);
    await put(w, incident, { lines: [expense('towing', '10')] });
    await expect(w.costService.get(tenantA, NO_COSTS, incident.id)).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(
      world(sourceB).costService.get(tenantA, MANAGER, incident.id),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(w.costService.get(tenantB, MANAGER, incident.id)).rejects.toMatchObject({
      code: 'not_found',
    });
    // The other database holds none of A's rows.
    expect(await db.rowsB(`SELECT 1 FROM ${T.lines}`)).toEqual([]);
  });

  it('counts the linked order once, live, beside the own lines; an order links only once per tenant (cases 1, 2, 3)', async () => {
    const w = world(sourceA);
    const orderId = `order-${randomUUID()}`;
    shared.orders.add(orderId, { costs: [{ amountMinor: '1000000', currency: 'MXN' }] }, tenantA);
    const first = await underReview(w);
    const second = await underReview(w);
    const linked = await w.links.link(
      tenantA,
      MANAGER,
      first.id,
      { version: first.version, orderId },
      key(),
    );
    await expect(
      w.links.link(tenantA, MANAGER, second.id, { version: second.version, orderId }, key()),
    ).rejects.toMatchObject({ code: 'duplicate' });
    expect(await count(R.links, 'company_id', tenantA, `order_id='${orderId}'`)).toBe(1);
    // The same order id in another tenant is another order.
    const outsider = await underReview(world(sourceB), tenantB);
    shared.orders.add(orderId, {}, tenantB);
    await world(sourceB).links.link(
      tenantB,
      MANAGER,
      outsider.id,
      { version: outsider.version, orderId },
      key(),
    );
    const saved = await put(w, linked.incident, {
      lines: [expense('deductible', '200000'), expense('towing', '50000'), recovery('800000')],
    });
    expect(saved.costs.totals[0]).toMatchObject({ repairs: '1000000', companyBorne: '450000' });
    shared.orders.add(orderId, { costs: [{ amountMinor: '1500000', currency: 'MXN' }] }, tenantA);
    expect(
      (await world(sourceA2).costService.get(tenantA, MANAGER, first.id)).costs.totals[0]
        ?.companyBorne,
    ).toBe('950000');
    // Unlinking releases the order and removes its share.
    const unlinked = await w.links.unlink(
      tenantA,
      MANAGER,
      first.id,
      linked.link.id,
      {
        version: saved.incident.version,
      },
      key(),
    );
    expect(unlinked.version).toBe(saved.incident.version + 1);
    expect(await count(R.links, 'company_id', tenantA, `order_id='${orderId}'`)).toBe(0);
    expect(
      (await w.costService.get(tenantA, MANAGER, first.id)).costs.totals[0]?.companyBorne,
    ).toBe('-550000');
  });

  it('closes with a snapshot of the cycle, reopens, and the second cycle gets its own (cases 5, 6, 8)', async () => {
    const w = world(sourceA);
    const incident = await resolved(w);
    const withCosts = await put(w, incident, { lines: [expense('towing', '100')] });
    const closed = await w.workflow.execute(
      tenantA,
      MANAGER,
      incident.id,
      {
        command: 'close',
        version: withCosts.incident.version,
      },
      key(),
    );
    expect(closed).toMatchObject({ status: 'closed', cycle: 1 });
    const [first] = await w.costs.snapshots(tenantA, incident.id);
    expect(first).toMatchObject({ cycle: 1, totals: [{ currency: 'MXN', companyBorne: '100' }] });
    // A closed case takes no more cost changes.
    await expect(put(w, closed, { lines: [] })).rejects.toMatchObject({
      code: 'invalid_transition',
    });
    const reopened = await w.workflow.execute(
      tenantA,
      MANAGER,
      incident.id,
      {
        command: 'reopen',
        version: closed.version,
        reason: 'Falta un dato',
      },
      key(),
    );
    const more = await put(w, reopened, {
      lines: [expense('towing', '100'), expense('fine', '50')],
    });
    expect(
      (await w.costService.get(tenantA, MANAGER, incident.id)).costs.differsFromLastClosure,
    ).toBe(true);
    const reviewed = await w.workflow.execute(
      tenantA,
      MANAGER,
      incident.id,
      { command: 'review', version: more.incident.version },
      key(),
    );
    const resolvedAgain = await w.process.updateResolution(tenantA, MANAGER, incident.id, {
      version: reviewed.version,
      resolutionSummary: 'Resuelto otra vez',
      vehicleStatusDecision: 'restricted',
    });
    const back = await w.workflow.execute(
      tenantA,
      MANAGER,
      incident.id,
      {
        command: 'resolve',
        version: resolvedAgain.version,
      },
      key(),
    );
    await w.workflow.execute(
      tenantA,
      MANAGER,
      incident.id,
      {
        command: 'close',
        version: back.version,
      },
      key(),
    );
    const snapshots = await w.costs.snapshots(tenantA, incident.id);
    expect(snapshots.map((s) => s.cycle)).toEqual([1, 2]);
    expect(snapshots[0]?.totals[0]?.companyBorne).toBe('100');
    expect(snapshots[1]?.totals[0]?.companyBorne).toBe('150');
    expect(
      (await w.costService.get(tenantA, MANAGER, incident.id)).costs.differsFromLastClosure,
    ).toBe(false);
  });

  it('a failing snapshot leaves the case open and no half snapshot (case 8)', async () => {
    const w = world(sourceA);
    const incident = await resolved(w);
    const before = await snapshot(incident.id);
    shared.orders.fail = false;
    await db.rows(
      `REVOKE INSERT ON \`${db.databaseName}\`.\`${T.snapshots}\` FROM '${db.runtimeUserA}'@'%'`,
    );
    try {
      await expect(
        w.workflow.execute(
          tenantA,
          MANAGER,
          incident.id,
          {
            command: 'close',
            version: incident.version,
          },
          key(),
        ),
      ).rejects.toBeDefined();
    } finally {
      await db.rows(
        `GRANT INSERT ON \`${db.databaseName}\`.\`${T.snapshots}\` TO '${db.runtimeUserA}'@'%'`,
      );
    }
    expect(await snapshot(incident.id)).toEqual(before);
    expect(await count(T.snapshots, 'company_id', tenantA, `incident_id='${incident.id}'`)).toBe(0);
    const retry = await w.workflow.execute(
      tenantA,
      MANAGER,
      incident.id,
      {
        command: 'close',
        version: incident.version,
      },
      key(),
    );
    expect(retry.status).toBe('closed');
  });

  for (const routine of [
    'opslog_enqueue_tenant_outbox',
    'opslog_append_local_audit_and_delivery',
  ]) {
    it(`leaves nothing behind when ${routine} fails (case 13)`, async () => {
      const w = world(sourceA);
      const incident = await underReview(w);
      const orderId = `order-${randomUUID()}`;
      shared.orders.add(orderId, {}, tenantA);
      const before = await snapshot(incident.id);
      await db.rows(
        `REVOKE EXECUTE ON PROCEDURE \`${db.databaseName}\`.\`${routine}\` FROM '${db.runtimeUserA}'@'%'`,
      );
      try {
        await expect(
          put(w, incident, {
            lines: [expense('towing', '10')],
            initialEstimate: { amountMinor: '3', currency: 'MXN' },
          }),
        ).rejects.toBeDefined();
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
      expect(await snapshot(incident.id)).toEqual(before);
      const retry = await put(w, incident, { lines: [expense('towing', '10')] });
      expect(retry.incident.version).toBe(incident.version + 1);
    });
  }

  it('concurrent twins with one key change once; two different edits of one version: one is stale (case 11)', async () => {
    const w = world(sourceA);
    const w2 = world(sourceA2);
    const incident = await underReview(w);
    const twin = key();
    const body = { lines: [expense('towing', '10')] };
    const [one, two] = await Promise.all([
      put(w, incident, body, tenantA, twin),
      put(w2, incident, body, tenantA, twin),
    ]);
    expect(one.incident.version).toBe(incident.version + 1);
    expect(two.incident.version).toBe(incident.version + 1);
    expect(
      await count(
        AUDIT_TABLES.outbox,
        'tenant_id',
        tenantA,
        `entity_id='${incident.id}' AND type='incident.costs_changed'`,
      ),
    ).toBe(1);
    await expect(put(w, incident, { lines: [] }, tenantA, twin)).rejects.toMatchObject({
      code: 'idempotency_conflict',
    });
    const other = await underReview(w);
    const results = await Promise.allSettled([
      put(w, other, { lines: [expense('towing', '1')] }),
      put(w2, other, { lines: [expense('towing', '2')] }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      (results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason,
    ).toMatchObject({ code: 'stale_version' });
    expect(await count(T.lines, 'company_id', tenantA, `incident_id='${other.id}'`)).toBe(1);
  });

  it('clears the approval when costs or links change (ADR-0014)', async () => {
    const w = world(sourceA);
    shared.threshold = { amountMinor: '1000', currency: 'MXN' };
    try {
      const incident = await resolved(w);
      const costly = await put(w, incident, { lines: [expense('towing', '1001')] });
      await expect(
        w.workflow.execute(
          tenantA,
          MANAGER,
          incident.id,
          {
            command: 'close',
            version: costly.incident.version,
          },
          key(),
        ),
      ).rejects.toMatchObject({ code: 'missing_requirements' });
      const approved = await w.workflow.execute(
        tenantA,
        MANAGER,
        incident.id,
        {
          command: 'approve_close',
          version: costly.incident.version,
        },
        key(),
      );
      expect(approved.closeApproval).not.toBeNull();
      const changed = await put(w, approved, { lines: [expense('towing', '1002')] });
      expect(changed.incident.closeApproval).toBeNull();
    } finally {
      shared.threshold = null;
    }
  });

  it('an approval lapses when the costs of the linked order grow in maintenance after it was given (D20)', async () => {
    const w = world(sourceA);
    shared.threshold = { amountMinor: '500000', currency: 'MXN' };
    try {
      const orderId = `order-${randomUUID()}`;
      shared.orders.add(
        orderId,
        { costs: [{ amountMinor: '600000', currency: 'MXN' }], status: 'closed' },
        tenantA,
      );
      const review = await underReview(w);
      const linked = await w.links.link(
        tenantA,
        MANAGER,
        review.id,
        { version: review.version, orderId },
        key(),
      );
      const filled = await w.process.updateResolution(tenantA, MANAGER, review.id, {
        version: linked.incident.version,
        resolutionSummary: 'Resuelto de forma sintética',
        vehicleStatusDecision: 'restricted',
      });
      const resolvedNow = await w.workflow.execute(tenantA, MANAGER, review.id, {
        command: 'resolve',
        version: filled.version,
      });
      const command = (name: string, version: number) =>
        w.workflow.execute(tenantA, MANAGER, review.id, { command: name, version }, key());
      const approved = await command('approve_close', resolvedNow.version);
      const [row] = await db.rows<{ borne: unknown }>(
        `SELECT borne FROM ${T.approvals} WHERE company_id=? AND incident_id=? AND kind='close'`,
        [tenantA, review.id],
      );
      expect(JSON.stringify(row?.borne)).toContain('600000');
      // The order grows in maintenance after the approval; it is read live.
      shared.orders.add(
        orderId,
        { costs: [{ amountMinor: '600001', currency: 'MXN' }], status: 'closed' },
        tenantA,
      );
      const before = await snapshot(review.id);
      await expect(command('close', approved.version)).rejects.toMatchObject({
        code: 'missing_requirements',
        missingRequirements: ['close_approval'],
      });
      expect(await snapshot(review.id)).toEqual(before);
      const again = await command('approve_close', approved.version);
      expect(again.version).toBe(approved.version + 1);
      expect((await command('close', again.version)).status).toBe('closed');
    } finally {
      shared.threshold = null;
    }
  });

  it('the runtime account cannot rewrite a snapshot, drop a table or touch the order tables (grants)', async () => {
    const w = world(sourceA);
    const incident = await resolved(w);
    await w.workflow.execute(
      tenantA,
      MANAGER,
      incident.id,
      {
        command: 'close',
        version: incident.version,
      },
      key(),
    );
    for (const sql of [
      `UPDATE ${T.snapshots} SET cycle=9`,
      `DELETE FROM ${T.snapshots}`,
      `UPDATE ${T.lines} SET currency='USD'`,
      `UPDATE ${R.links} SET order_id='x'`,
      `DROP TABLE ${R.links}`,
      `INSERT INTO ${T.lines} (company_id,incident_id,id,position,kind,category,amount_minor,currency) VALUES ('${tenantA}','${incident.id}','z',0,'expense','towing',0,'MXN')`,
      `INSERT INTO ${T.lines} (company_id,incident_id,id,position,kind,category,amount_minor,currency) VALUES ('${tenantA}','${incident.id}','z',0,'expense','insurer',5,'MXN')`,
      `INSERT INTO ${T.lines} (company_id,incident_id,id,position,kind,category,amount_minor,currency) VALUES ('${tenantA}','${incident.id}','z',0,'expense','towing',5,'mxn')`,
    ])
      await expect(sourceA.query(sql), sql).rejects.toBeDefined();
    expect(await count(T.snapshots, 'company_id', tenantA, `incident_id='${incident.id}'`)).toBe(1);
  });

  it('a failed order read is an error, never a zero in the answer', async () => {
    const w = world(sourceA);
    const incident = await underReview(w);
    const orderId = `order-${randomUUID()}`;
    shared.orders.add(orderId, { costs: [{ amountMinor: '5', currency: 'MXN' }] }, tenantA);
    const linked = await w.links.link(
      tenantA,
      MANAGER,
      incident.id,
      { version: incident.version, orderId },
      key(),
    );
    shared.orders.fail = true;
    try {
      await expect(w.costService.get(tenantA, MANAGER, incident.id)).rejects.toThrow(
        'orders unavailable',
      );
      await expect(put(w, linked.incident, { lines: [expense('towing', '1')] })).rejects.toThrow(
        'orders unavailable',
      );
    } finally {
      shared.orders.fail = false;
    }
    // The change itself is committed (it needs no order); the answer is what fails.
    expect(await count(T.lines, 'company_id', tenantA, `incident_id='${incident.id}'`)).toBe(1);
  });
});
