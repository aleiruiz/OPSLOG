import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryTenantStore } from '../../../apps/api/composition/src/index.js';
import {
  createBffWorld,
  type BffWorld,
  type Browser,
} from '../../../apps/api/bff/src/test-support.js';
import {
  AUDIT_TABLES,
  createMySqlAuditRuntime,
} from '../../../packages/persistence/audit/src/index.js';
import {
  auditAdminUrl,
  startAuditDatabase,
  type AuditDatabase,
} from '../../../packages/persistence/audit/src/test-support/mysql.js';

/**
 * The audit screens on the real MySQL audit store (CI: mysql service, OPSLOG_TEST_MYSQL_ADMIN_URL; locally
 * skipped when unset, a hard failure in CI). Only the audit is durable; the business modules stay in memory,
 * since the audit rows of vehicles and areas are written through the platform kernel. Two companies share one
 * database (the tenant is a column), so equal local ids are a real case. Only synthetic data.
 */
const suite = auditAdminUrl ? describe : describe.skip;
const P = '/api/v1/audit';
const WIDE = 'from=2026-01-01T00:00:00.000Z&to=2026-12-31T00:00:00.000Z';

suite('audit query on the real MySQL audit store', () => {
  let database: AuditDatabase;
  let world: BffWorld;
  let auditorA: Browser;
  let adminA: Browser;
  let adminB: Browser;
  let runBatch: () => Promise<number>;
  let tenantA: string;
  let tenantB: string;
  let sources: { runtime: Awaited<ReturnType<AuditDatabase['openRuntime']>>; relay: unknown };

  beforeAll(async () => {
    database = await startAuditDatabase('aqp');
    const runtime = await database.openRuntime();
    const relay = await database.openRelay();
    sources = { runtime, relay };
    const tenants = new InMemoryTenantStore();
    const auditRuntime = createMySqlAuditRuntime({
      listTenantIds: () => tenants.all().map((tenant) => tenant.id),
      resolveRuntime: () => runtime,
      resolveRelay: () => relay,
      resolveReader: () => runtime,
    });
    runBatch = () => auditRuntime.auditRelay.runBatch(500);
    world = createBffWorld({
      adapters: {
        tenants,
        audit: auditRuntime.audit,
        auditRelay: auditRuntime.auditRelay,
        outbox: auditRuntime.outbox,
      },
    });
    tenantA = (await world.tenant('Empresa Alfa', 'subject-admin-a')).tenantId;
    tenantB = (await world.tenant('Empresa Beta', 'subject-admin-b')).tenantId;
    await world.member('subject-admin-a', 'auditor', 'subject-auditor-a');
    adminA = await world.loginAs('subject-admin-a');
    auditorA = await world.loginAs('subject-auditor-a');
    adminB = await world.loginAs('subject-admin-b');
    await runBatch();
  }, 180_000);

  afterAll(async () => {
    world?.dispose();
    await database?.close();
  }, 60_000);

  const area = async (browser: Browser, name: string) => {
    const reply = await browser.post('/api/areas', { json: { name } });
    expect(reply.status, reply.text).toBe(201);
    return reply.json.id as string;
  };

  it('keeps the local audit append-only for the runtime and relay accounts (SPECS §9.3)', async () => {
    await area(adminA, 'Flota append-only');
    await runBatch();
    const { runtime } = sources;
    const relay = sources.relay as typeof runtime;
    const t = AUDIT_TABLES;
    for (const [account, sql] of [
      [runtime, `UPDATE ${t.local} SET action = 'x'`],
      [runtime, `DELETE FROM ${t.local}`],
      [runtime, `UPDATE ${t.projection} SET action = 'x'`],
      [runtime, `DELETE FROM ${t.projection}`],
      [runtime, `INSERT INTO ${t.projection} (tenant_id) VALUES ('x')`],
      [relay, `UPDATE ${t.local} SET action = 'x'`],
      [relay, `DELETE FROM ${t.local}`],
      [relay, `DELETE FROM ${t.projection}`],
      [relay, `UPDATE ${t.projection} SET action = 'x'`],
      [relay, `DELETE FROM ${t.delivery}`],
      [relay, `UPDATE ${t.registry} SET content_hash = REPEAT('0', 64)`],
    ] as const)
      await expect(account.query(sql), sql).rejects.toBeDefined();
    const [rows] = (await database.admin.query(`SELECT COUNT(*) AS n FROM ${t.local}`)) as [
      { n: number }[],
      unknown,
    ];
    expect(Number(rows[0]?.n)).toBeGreaterThan(0);
  });

  it('lists events only after the relay and reports them as pending with their age until then (FR-170)', async () => {
    await runBatch();
    const before = await auditorA.get(`${P}/reconciliation?${WIDE}`);
    expect(before.json.pendingTotal).toBe(0);
    const id = await area(adminA, 'Flota pendiente');
    world.advance(90_000);
    const pending = await auditorA.get(`${P}/reconciliation?${WIDE}`);
    expect(pending.status, pending.text).toBe(200);
    expect(pending.json.pendingTotal).toBeGreaterThanOrEqual(1);
    expect(pending.json.pending[0]).toMatchObject({
      action: 'area.created',
      entityType: 'area',
      delivery: 'pending',
    });
    expect(pending.json.oldestPendingAgeSeconds).toBeGreaterThanOrEqual(0);
    const hidden = await auditorA.get(`${P}?${WIDE}&entityType=area&entityId=${id}`);
    expect(hidden.json.items).toEqual([]);
    await runBatch();
    const done = await auditorA.get(`${P}/reconciliation?${WIDE}`);
    expect(done.json).toMatchObject({
      pendingTotal: 0,
      pending: [],
      oldestPendingAgeSeconds: null,
    });
    expect(done.json.local).toBe(done.json.relayed);
    const shown = await auditorA.get(`${P}?${WIDE}&entityType=area&entityId=${id}`);
    expect(shown.json.items.map((item: { action: string }) => item.action)).toEqual([
      'area.created',
    ]);
    expect(shown.json.items[0].entityLabel).toBe('Flota pendiente');
  });

  it('never shows company B rows to A, and refuses a cursor of B in A', async () => {
    const idB = await area(adminB, 'Zona exclusiva de Beta');
    for (let n = 0; n < 27; n += 1) await area(adminB, `Zona ${n}`);
    await runBatch();
    const foreign = await auditorA.get(`${P}?${WIDE}&entityId=${idB}`);
    expect(foreign.json.items).toEqual([]);
    expect(foreign.text).not.toContain('Zona');
    const pageB = await adminB.get(`${P}?${WIDE}&limit=25`);
    expect(pageB.json.nextCursor).toEqual(expect.any(String));
    const stolen = await auditorA.get(
      `${P}?${WIDE}&limit=25&cursor=${encodeURIComponent(pageB.json.nextCursor)}`,
    );
    expect(stolen.status).toBe(400);
    expect(tenantA).not.toBe(tenantB);
    const totalA = (await auditorA.get(`${P}?${WIDE}`)).json.total as number;
    const rowsA = (await database.admin.query(
      `SELECT COUNT(*) AS n FROM ${AUDIT_TABLES.projection} WHERE tenant_id = ?`,
      [tenantA],
    )) as [{ n: number }[], unknown];
    expect(totalA).toBe(Number(rowsA[0][0]?.n));
  });

  it('pages 60 events by keyset without gaps or repeats', async () => {
    for (let n = 0; n < 60; n += 1) await area(adminA, `Paginada ${n}`);
    await runBatch();
    const seen: string[] = [];
    let cursor: string | null = null;
    let total = 0;
    for (let guard = 0; guard < 20; guard += 1) {
      const page: {
        json: { items: { eventId: string }[]; nextCursor: string | null; total: number };
      } = await auditorA.get(
        `${P}?${WIDE}&limit=25&action=area.${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      seen.push(...page.json.items.map((item) => item.eventId));
      total = page.json.total;
      cursor = page.json.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
  });

  it('answers the first filtered page of 200,000 rows within 500 ms at p95 (SPECS §9.3)', async () => {
    const perf = 'tenant-perf-synthetic';
    await database.admin.query('SET SESSION cte_max_recursion_depth = 250000');
    await database.admin.query(
      `INSERT INTO ${AUDIT_TABLES.projection}
         (tenant_id, event_id, action, entity_type, entity_id, occurred_at, actor_id, actor_kind, correlation_id, data, content_hash)
       WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 200000)
       SELECT ?, CONCAT('perf-', n),
              ELT(1 + n % 5, 'vehicle.updated', 'incident.updated', 'area.created', 'document.renewed', 'file.downloaded'),
              ELT(1 + n % 5, 'vehicle', 'incident', 'area', 'document', 'file'),
              CONCAT('ent-', n % 2000),
              TIMESTAMPADD(SECOND, -(n * 38), '2026-10-19 00:00:00'),
              CONCAT('user-', LPAD(n % 40, 8, '0'), '-0000-0000-0000-000000000000'), 'user',
              CONCAT('corr-', n), JSON_OBJECT('attempts', 1), SHA2(CONCAT('perf-', n), 256)
       FROM seq`,
      [perf],
    );
    await database.admin.query(`ANALYZE TABLE ${AUDIT_TABLES.projection}`);
    const { runtime } = sources;
    const { MySqlAuditApiStore } = await import('../../../packages/persistence/audit/src/index.js');
    const store = new MySqlAuditApiStore(() => runtime);
    const range = { from: '2025-01-01T00:00:00.000Z', to: '2026-10-19T00:00:00.000Z' };
    const queries = [
      { ...range },
      { ...range, entityType: 'incident', entityId: 'ent-1' },
      { ...range, actionPrefix: 'vehicle.' },
      { ...range, actorId: 'user-00000007-0000-0000-0000-000000000000' },
      {
        from: '2026-09-01T00:00:00.000Z',
        to: '2026-09-08T00:00:00.000Z',
        result: 'success' as const,
      },
    ];
    const timings: number[] = [];
    let rows = 0;
    for (let round = 0; round < 8; round += 1)
      for (const filter of queries) {
        const started = performance.now();
        const slice = await store.query(perf, filter, { limit: 100 });
        timings.push(performance.now() - started);
        rows += slice.rows.length;
      }
    timings.sort((a, b) => a - b);
    const p95 = timings[Math.ceil(timings.length * 0.95) - 1] as number;
    expect(rows).toBeGreaterThan(0);
    expect(p95, `p95 ${p95.toFixed(1)} ms over ${timings.length} pages`).toBeLessThanOrEqual(500);
  }, 180_000);
});
