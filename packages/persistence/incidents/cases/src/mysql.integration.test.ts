import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import {
  IncidentService,
  InMemoryIncidentStore,
  type IncidentActor,
  type IncidentListQuery,
  type IncidentReferences,
} from '../../../../domain/incidents/cases/src/index.js';
import { AUDIT_TABLES } from '../../../audit/src/index.js';
import { INCIDENT_TABLES } from './entities.js';
import { TypeOrmIncidentStore } from './store.js';
import {
  adminUrl,
  startIncidentDatabase,
  type IncidentTestDatabase,
} from './test-support/mysql.js';

const suite = adminUrl ? describe : describe.skip;
const MANAGER: IncidentActor = {
  id: `user-${randomUUID()}`,
  subject: randomUUID(),
  permissions: ['incidents:view', 'incidents:create', 'incidents:edit'],
  mechanicLinked: false,
};
const draft = { vehicleId: 'vehicle-1', type: 'collision' };

const refs = (zone = 'UTC'): IncidentReferences => ({
  vehicle: async (_tenant, id) =>
    id === 'vehicle-1' ? { id, areaId: 'area-1', registeredOn: '2026-01-01' } : null,
  driver: async (_tenant, id) => (id === 'driver-1' ? { id, displayName: 'Ana' } : null),
  assignments: async () => [],
  policyRevisions: async () => [
    {
      policyId: 'policy-1',
      revision: 1,
      insurer: 'Aseguradora',
      policyNumber: 'POL-1',
      coverageType: 'comprehensive',
      startsOn: '2026-01-01',
      endsOn: '2026-12-31',
    },
  ],
  timeZone: async () => zone,
});

suite('incident cases on disposable MySQL 8.4', () => {
  let db: IncidentTestDatabase;
  let sourceA: DataSource;
  let sourceA2: DataSource;
  let sourceB: DataSource;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const now = new Date('2026-10-13T18:00:00.000Z');
  const service = (source: DataSource, zone = 'UTC', clock: () => Date = () => now) =>
    new IncidentService(new TypeOrmIncidentStore(source), refs(zone), { now: clock });
  const count = async (table: string, tenantColumn: string, tenant: string, extra = '1=1') => {
    const [row] = await db.rows<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${table} WHERE ${tenantColumn}=? AND ${extra}`,
      [tenant],
    );
    return Number(row?.n);
  };

  beforeAll(async () => {
    db = await startIncidentDatabase('cases');
    sourceA = await db.openIncidents('a');
    sourceA2 = await db.openIncidents('a');
    sourceB = await db.openIncidents('b');
  }, 180_000);
  afterAll(async () => {
    await db?.close();
  }, 60_000);

  it('commits incident, timeline, audit and a minimal outbox event in one transaction', async () => {
    const created = await service(sourceA).create(tenantA, MANAGER, {
      ...draft,
      description: 'Descripción sensible',
      location: { text: 'Calle privada 12' },
      occurredAt: '2026-10-12T15:30:00Z',
      damage: { description: 'Cofre', zones: ['rear', 'front'] },
    });
    expect(created).toMatchObject({ status: 'draft', coverageStatus: 'covered', version: 1 });
    expect(created.folio).toMatch(/^SIN-2026-\d{6}$/);
    const stored = await new TypeOrmIncidentStore(sourceA).get(tenantA, created.id);
    expect(stored).toEqual(created);
    expect(stored?.damage.zones).toEqual(['front', 'rear']);
    const timeline = await new TypeOrmIncidentStore(sourceA).history(tenantA, created.id);
    expect(timeline).toMatchObject([{ sequence: 1, command: 'create', from: null, to: 'draft' }]);
    expect(await count(AUDIT_TABLES.local, 'tenant_id', tenantA, `entity_id='${created.id}'`)).toBe(
      1,
    );
    const outbox = await db.rows<{ type: string; payload: Record<string, unknown> }>(
      `SELECT type, payload FROM ${AUDIT_TABLES.outbox} WHERE tenant_id=? AND entity_id=?`,
      [tenantA, created.id],
    );
    expect(outbox).toHaveLength(1);
    expect(Object.keys(outbox[0]?.payload ?? {}).sort()).toEqual([
      'incidentId',
      'vehicleId',
      'version',
    ]);
    const audit = await db.rows(`SELECT * FROM ${AUDIT_TABLES.local} WHERE tenant_id=?`, [tenantA]);
    expect(JSON.stringify([outbox, audit])).not.toMatch(/sensible|privada|Cofre/);

    const edited = await service(sourceA).update(tenantA, MANAGER, created.id, {
      version: 1,
      severity: 'high',
      description: 'Otro texto',
    });
    expect(edited.version).toBe(2);
    const history = await new TypeOrmIncidentStore(sourceA).history(tenantA, created.id);
    expect(history.map((t) => [t.sequence, t.command])).toEqual([
      [1, 'create'],
      [2, 'update'],
    ]);
    expect(history[1]?.changedFields).toEqual(['description', 'severity']);
  });

  it('numbers folios atomically across two connections, never reuses one and counts per tenant', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        service(i % 2 ? sourceA : sourceA2).create(tenantA, MANAGER, { ...draft, severity: 'low' }),
      ),
    );
    const numbers = results.map((i) => Number(i.folio.slice(-6))).sort((a, b) => a - b);
    expect(new Set(numbers).size).toBe(6);
    expect(numbers.at(-1)! - numbers[0]!).toBe(5);
    // A cancelled draft keeps its folio, so the next one is above it.
    const victim = results[0]!;
    await db.rows(
      `UPDATE ${INCIDENT_TABLES.incidents} SET status='cancelled', cancel_reason='fixture' WHERE company_id=? AND id=?`,
      [tenantA, victim.id],
    );
    const next = await service(sourceA).create(tenantA, MANAGER, draft);
    expect(Number(next.folio.slice(-6))).toBeGreaterThan(Math.max(...numbers));
    // Tenant B has its own sequence.
    const first = await service(sourceB).create(tenantB, MANAGER, draft);
    expect(first.folio).toBe('SIN-2026-000001');
  });

  it('takes the folio year from the tenant calendar', async () => {
    const newYear = () => new Date('2027-01-01T02:00:00.000Z');
    const local = await service(sourceA, 'America/Mexico_City', newYear).create(
      tenantA,
      MANAGER,
      draft,
    );
    expect(local.folio).toMatch(/^SIN-2026-/);
    const utc = await service(sourceB, 'UTC', newYear).create(tenantB, MANAGER, draft);
    expect(utc.folio).toBe('SIN-2027-000001');
  });

  for (const routine of [
    'opslog_enqueue_tenant_outbox',
    'opslog_append_local_audit_and_delivery',
  ]) {
    it(`leaves nothing behind when ${routine} fails`, async () => {
      const key = `atomic-${routine.slice(0, 30)}`;
      const before = {
        incidents: await count(INCIDENT_TABLES.incidents, 'company_id', tenantA),
        transitions: await count(INCIDENT_TABLES.transitions, 'company_id', tenantA),
        audit: await count(AUDIT_TABLES.local, 'tenant_id', tenantA),
        outbox: await count(AUDIT_TABLES.outbox, 'tenant_id', tenantA),
        folio: await db.rows(
          `SELECT last_sequence FROM ${INCIDENT_TABLES.folios} WHERE company_id=?`,
          [tenantA],
        ),
      };
      await db.rows(
        `REVOKE EXECUTE ON PROCEDURE \`${db.databaseName}\`.\`${routine}\` FROM '${db.runtimeUserA}'@'%'`,
      );
      try {
        await expect(service(sourceA).create(tenantA, MANAGER, draft, key)).rejects.toBeDefined();
      } finally {
        await db.rows(
          `GRANT EXECUTE ON PROCEDURE \`${db.databaseName}\`.\`${routine}\` TO '${db.runtimeUserA}'@'%'`,
        );
      }
      expect({
        incidents: await count(INCIDENT_TABLES.incidents, 'company_id', tenantA),
        transitions: await count(INCIDENT_TABLES.transitions, 'company_id', tenantA),
        audit: await count(AUDIT_TABLES.local, 'tenant_id', tenantA),
        outbox: await count(AUDIT_TABLES.outbox, 'tenant_id', tenantA),
        folio: await db.rows(
          `SELECT last_sequence FROM ${INCIDENT_TABLES.folios} WHERE company_id=?`,
          [tenantA],
        ),
      }).toEqual(before);
      expect(
        await count(INCIDENT_TABLES.idempotency, 'company_id', tenantA, `idempotency_key='${key}'`),
      ).toBe(0);
      // The retry with the same key runs normally once the routine is back.
      const retry = await service(sourceA).create(tenantA, MANAGER, draft, key);
      expect(retry.status).toBe('draft');
    });
  }

  it('lets exactly one of two concurrent patches win', async () => {
    const created = await service(sourceA).create(tenantA, MANAGER, draft);
    const results = await Promise.allSettled([
      service(sourceA).update(tenantA, MANAGER, created.id, { version: 1, severity: 'low' }),
      service(sourceA2).update(tenantA, MANAGER, created.id, { version: 1, severity: 'high' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'stale_version' },
    });
    expect(
      await count(
        INCIDENT_TABLES.transitions,
        'company_id',
        tenantA,
        `incident_id='${created.id}' AND command='update'`,
      ),
    ).toBe(1);
  });

  it('creates one incident per Idempotency-Key and rejects another body', async () => {
    const [a, b] = await Promise.all([
      service(sourceA).create(tenantA, MANAGER, draft, 'idem-key-0001'),
      service(sourceA2).create(tenantA, MANAGER, draft, 'idem-key-0001'),
    ]);
    expect(b).toEqual(a);
    expect(
      await count(
        INCIDENT_TABLES.idempotency,
        'company_id',
        tenantA,
        `idempotency_key='idem-key-0001'`,
      ),
    ).toBe(1);
    expect(await count(INCIDENT_TABLES.incidents, 'company_id', tenantA, `id='${a.id}'`)).toBe(1);
    await expect(
      service(sourceA).create(tenantA, MANAGER, { ...draft, type: 'other' }, 'idem-key-0001'),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    // The same key in another tenant is another command.
    const other = await service(sourceB).create(tenantB, MANAGER, draft, 'idem-key-0001');
    expect(other.id).not.toBe(a.id);
  });

  it('isolates tenants by database and by tenant key', async () => {
    const created = await service(sourceA).create(tenantA, MANAGER, draft);
    expect(await new TypeOrmIncidentStore(sourceA).get(tenantB, created.id)).toBeNull();
    expect(await new TypeOrmIncidentStore(sourceB).get(tenantA, created.id)).toBeNull();
    await expect(service(sourceA).get(tenantB, MANAGER, created.id)).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      service(sourceA).update(tenantB, MANAGER, created.id, { version: 1, severity: 'low' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      sourceA.query(`SELECT id FROM \`${db.otherDatabaseName}\`.\`${INCIDENT_TABLES.incidents}\``),
    ).rejects.toBeDefined();
  });

  it('gives the runtime account only the documented grants', async () => {
    await expect(sourceA.query('CREATE TABLE opslog_incident_evil (id INT)')).rejects.toBeDefined();
    await expect(
      sourceA.query(`ALTER TABLE ${INCIDENT_TABLES.incidents} ADD COLUMN evil INT`),
    ).rejects.toBeDefined();
    await expect(sourceA.query(`DROP TABLE ${INCIDENT_TABLES.incidents}`)).rejects.toBeDefined();
    await expect(
      sourceA.query(`UPDATE ${INCIDENT_TABLES.transitions} SET command='x'`),
    ).rejects.toBeDefined();
    await expect(sourceA.query(`DELETE FROM ${INCIDENT_TABLES.transitions}`)).rejects.toBeDefined();
    await expect(sourceA.query(`DELETE FROM ${INCIDENT_TABLES.incidents}`)).rejects.toBeDefined();
    await expect(
      sourceA.query(`UPDATE ${INCIDENT_TABLES.idempotency} SET status='completed'`),
    ).rejects.toBeDefined();
    await expect(sourceA.query(`DELETE FROM ${INCIDENT_TABLES.folios}`)).rejects.toBeDefined();
    await expect(sourceA.query(`UPDATE ${AUDIT_TABLES.outbox} SET type='x'`)).rejects.toBeDefined();
    const grants = await db.rows<Record<string, string>>(
      `SHOW GRANTS FOR '${db.runtimeUserA}'@'%'`,
    );
    const text = grants.map((row) => Object.values(row)[0]).join('\n');
    expect(text).not.toMatch(/ALL PRIVILEGES|WITH GRANT OPTION|\bDROP\b|\bCREATE\b|\bALTER\b/);
  });

  it('rejects rows that break the model even from a buggy writer', async () => {
    const created = await service(sourceA).create(tenantA, MANAGER, draft);
    for (const change of [
      "status='bogus'",
      "type='bogus'",
      "severity='bogus'",
      "folio='X-1'",
      "coverage_status='covered'",
      "driver_id='d', no_driver_reason='r'",
      'version=0',
    ])
      await expect(
        db.rows(`UPDATE ${INCIDENT_TABLES.incidents} SET ${change} WHERE company_id=? AND id=?`, [
          tenantA,
          created.id,
        ]),
      ).rejects.toBeDefined();
    await expect(
      db.rows(
        `INSERT INTO ${INCIDENT_TABLES.transitions} (company_id,incident_id,sequence,command,to_status,actor_id,occurred_at,changed_fields) VALUES (?, 'missing', 1, 'x', 'draft', 'user-x', NOW(6), JSON_ARRAY())`,
        [tenantA],
      ),
    ).rejects.toBeDefined();
  });

  it('lists exactly like the in-memory store: filters, sorts, tiebreak and total', async () => {
    const tenant = randomUUID();
    let tick = 0;
    const clock = () => new Date(now.getTime() + (tick += 1000));
    const mysqlStore = new TypeOrmIncidentStore(sourceA);
    const memory = new InMemoryIncidentStore();
    let n = 0;
    const live = new IncidentService(mysqlStore, refs(), {
      now: clock,
      newId: () => `ord-${String(++n).padStart(2, '0')}`,
    });
    const twin = new IncidentService(memory, refs(), {
      now: clock,
      newId: () => `ord-${String(n).padStart(2, '0')}`,
    });
    // Build the same cases on both stores with the same clock and ids.
    const bodies = [
      { ...draft, severity: 'low', occurredAt: '2026-05-01T12:00:00Z' },
      { ...draft, type: 'other', severity: 'critical', occurredAt: '2026-04-01T12:00:00Z' },
      { ...draft, severity: 'medium', occurredAt: '2026-06-01T12:00:00Z' },
      { ...draft, type: 'theft_total' },
      { ...draft, severity: 'high', occurredAt: '2026-03-01T12:00:00Z' },
      { ...draft, severity: 'low', occurredAt: '2026-05-01T12:00:00Z' },
    ];
    for (const body of bodies) {
      const startTick = tick;
      await live.create(tenant, MANAGER, body);
      tick = startTick;
      await twin.create(tenant, MANAGER, body);
    }
    const queries: Partial<IncidentListQuery>[] = [
      {},
      { sort: 'severity', direction: 'desc' },
      { sort: 'severity', direction: 'asc' },
      { sort: 'occurredAt', direction: 'asc' },
      { sort: 'occurredAt', direction: 'desc' },
      { sort: 'folio', direction: 'desc' },
      { filter: { severity: 'low' } },
      { filter: { type: 'other' } },
      { filter: { statuses: ['draft', 'closed'] } },
      { filter: { occurredFrom: '2026-04-15', occurredTo: '2026-06-30' } },
      { filter: { vehicleId: 'vehicle-1', createdBy: MANAGER.id } },
      { limit: 25, offset: 4 },
    ];
    for (const partial of queries) {
      const query: IncidentListQuery = {
        filter: {},
        sort: 'createdAt',
        direction: 'desc',
        limit: 25,
        offset: 0,
        ...partial,
      };
      const [real, expected] = await Promise.all([
        mysqlStore.list(tenant, query),
        memory.list(tenant, query),
      ]);
      expect(real.total).toBe(expected.total);
      expect(real.items.map((i) => i.id)).toEqual(expected.items.map((i) => i.id));
    }
    const page = await mysqlStore.list(tenant, {
      filter: {},
      sort: 'folio',
      direction: 'asc',
      limit: 25,
      offset: 2,
    });
    expect(page.items).toHaveLength(4);
    expect(page.total).toBe(6);
  });
});
