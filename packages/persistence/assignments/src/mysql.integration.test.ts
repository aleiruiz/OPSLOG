import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { AUDIT_MIGRATIONS_TABLE, AUDIT_TABLES } from '../../audit/src/index.js';
import {
  AssignmentError,
  AssignmentService,
  applyEnd,
  assignedEvent,
  endedEvent,
  type Assignment,
} from '../../../domain/assignments/src/index.js';
import { ASSIGNMENT_TABLES, BINARY_COLLATION } from './entities.js';
import { AssignmentStoreError } from './errors.js';
import { TypeOrmAssignmentStore, type StoreErrorEvent } from './store.js';
import {
  adminUrl,
  startAssignmentsDatabase,
  type AssignmentsDatabase,
} from './test-support/mysql.js';

const suite = adminUrl ? describe : describe.skip;
const auditSchemaTables = [
  ...Object.values(AUDIT_TABLES),
  'opslog_audit_local_keys',
  AUDIT_MIGRATIONS_TABLE,
];

const NOW = new Date('2026-10-06T12:00:00.000Z');
const ACTOR = 'user-11111111-1111-4111-8111-111111111111';
const T = ASSIGNMENT_TABLES;

const assignment = (tenant: string, id: string, over: Partial<Assignment> = {}): Assignment => ({
  id,
  tenantId: tenant,
  vehicleId: 'veh-1',
  employeeId: 'emp-1',
  type: 'principal',
  reason: 'Alta de unidad',
  assignedBy: ACTOR,
  startedAt: NOW.toISOString(),
  endedAt: null,
  endKind: null,
  endReason: null,
  endedBy: null,
  version: 1,
  updatedAt: NOW.toISOString(),
  ...over,
});
const closed = (a: Assignment, kind: 'ended' | 'replaced' = 'ended') =>
  applyEnd(a, kind, 'Cierre', ACTOR, a.version, new Date('2026-10-07T00:00:00.000Z'));

const rejection = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
};

/** The error of a statement, or undefined when it succeeds. */
const outcome = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
};

const errnoOf = (error: unknown): number | undefined =>
  (error as { errno?: number; driverError?: { errno?: number } }).driverError?.errno ??
  (error as { errno?: number }).errno;

const window = { limit: 50, offset: 0 };
const insert = (db: AssignmentsDatabase, table: string, row: Record<string, unknown>) => {
  const columns = Object.keys(row);
  return outcome(
    db.admin.query(
      `INSERT INTO ${table} (${columns.map((c) => `\`${c}\``).join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
      Object.values(row),
    ),
  );
};

suite('persistent assignment store on MySQL', () => {
  let db: AssignmentsDatabase;
  let sourceA: DataSource;
  let sourceB: DataSource;
  let storeA: TypeOrmAssignmentStore;
  let storeB: TypeOrmAssignmentStore;
  let svcA: AssignmentService;
  let svcB: AssignmentService;
  const events: StoreErrorEvent[] = [];

  beforeAll(async () => {
    db = await startAssignmentsDatabase('store');
    sourceA = await db.openRuntime();
    sourceB = await db.openRuntime();
    storeA = new TypeOrmAssignmentStore(sourceA, { onError: (event) => events.push(event) });
    // A second pool stands in for another API process.
    storeB = new TypeOrmAssignmentStore(sourceB);
    svcA = new AssignmentService(storeA, { now: () => new Date() });
    svcB = new AssignmentService(storeB, { now: () => new Date() });
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  }, 60_000);

  const row = (patch: Record<string, unknown> = {}) => ({
    company_id: 'tenant-checks',
    id: randomUUID(),
    vehicle_id: 'veh-1',
    employee_id: 'emp-1',
    type: 'secondary',
    reason: 'Alta de unidad',
    assigned_by: ACTOR,
    started_at: NOW,
    ended_at: null,
    end_kind: null,
    end_reason: null,
    ended_by: null,
    current_flag: 1,
    principal_flag: null,
    version: 1,
    updated_at: NOW,
    ...patch,
  });

  describe('schema', () => {
    it('is created in its own migrations table with binary collations and company-keyed keys', async () => {
      const tables = await db.rows<{ t: string }>(
        'SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?',
        [db.databaseName],
      );
      const moduleTableList = Object.values(T)
        .map((name) => `'${name}'`)
        .join(', ');
      expect(tables.map((r) => r.t).sort()).toEqual(
        [...Object.values(T), 'opslog_assignments_migrations', ...auditSchemaTables].sort(),
      );
      const columns = await db.rows<{ coll: string }>(
        `SELECT COLLATION_NAME AS coll FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = ? AND DATA_TYPE IN ('varchar', 'char') AND TABLE_NAME IN (${moduleTableList})`,
        [db.databaseName],
      );
      expect(columns.length).toBeGreaterThan(10);
      expect(columns.filter((column) => column.coll !== BINARY_COLLATION)).toEqual([]);
      const keys = await db.rows<{ table: string; name: string; col: string; seq: number }>(
        `SELECT TABLE_NAME AS \`table\`, INDEX_NAME AS name, COLUMN_NAME AS col, SEQ_IN_INDEX AS seq FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (${moduleTableList})`,
        [db.databaseName],
      );
      // Every index, the primary keys included, starts with company_id.
      for (const key of keys.filter((candidate) => candidate.seq === 1))
        expect([key.table, key.name, key.col]).toEqual([key.table, key.name, 'company_id']);
      const unique = await db.rows<{ name: string }>(
        `SELECT DISTINCT INDEX_NAME AS name FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND NON_UNIQUE = 0 AND INDEX_NAME <> 'PRIMARY'`,
        [db.databaseName, T.assignments],
      );
      expect(unique.map((u) => u.name).sort()).toEqual([
        'ux_assignments_current_pair',
        'ux_assignments_principal_employee',
        'ux_assignments_principal_vehicle',
      ]);
    });

    it('rejects malformed assignment rows by CHECK constraint, whoever writes them', async () => {
      const ended = {
        ended_at: new Date('2026-10-07T00:00:00Z'),
        end_kind: 'ended',
        end_reason: 'Cierre',
        ended_by: ACTOR,
        current_flag: null,
        version: 2,
      };
      const illegal: Record<string, Record<string, unknown>> = {
        'unknown type': { type: 'owner' },
        'blank reason': { reason: '   ' },
        'version zero': { version: 0 },
        'current without flag': { current_flag: null },
        'flag on an ended row': { ...ended, current_flag: 1 },
        'current with an end reason': { end_reason: 'x' },
        'ended without kind': { ...ended, end_kind: null },
        'ended with unknown kind': { ...ended, end_kind: 'vanished' },
        'ended without reason': { ...ended, end_reason: null },
        'ended without actor': { ...ended, ended_by: null },
        'ended at version one': { ...ended, version: 1 },
        'ended before it started': { ...ended, ended_at: new Date('2020-01-01T00:00:00Z') },
        'principal without flag': { type: 'principal' },
        'secondary with principal flag': { principal_flag: 1 },
        'ended principal keeping the flag': { ...ended, type: 'principal', principal_flag: 1 },
      };
      for (const [label, patch] of Object.entries(illegal)) {
        const error = await insert(db, T.assignments, row(patch));
        expect([label, errnoOf(error)]).toEqual([label, 3819]);
      }
      expect(
        await insert(db, T.assignments, row({ type: 'principal', principal_flag: 1 })),
      ).toBeUndefined();
      expect(
        await insert(db, T.assignments, row({ ...ended, vehicle_id: 'veh-9', employee_id: 'e9' })),
      ).toBeUndefined();
    });

    it('rejects malformed event rows and events of an assignment that does not exist', async () => {
      const parent = row({ company_id: 'tenant-events', vehicle_id: 'v', employee_id: 'e' });
      await insert(db, T.assignments, parent);
      const event = (patch: Record<string, unknown>) => ({
        company_id: 'tenant-events',
        assignment_id: parent.id,
        seq: 1,
        kind: 'assigned',
        actor_id: ACTOR,
        reason: 'Alta',
        at: NOW,
        ...patch,
      });
      for (const patch of [
        { kind: 'edited' },
        { seq: 2 },
        { seq: 1, kind: 'ended' },
        { seq: 3, kind: 'ended' },
        { seq: 0 },
        { reason: ' ' },
      ])
        expect(errnoOf(await insert(db, T.events, event(patch)))).toBe(3819);
      expect(errnoOf(await insert(db, T.events, event({ company_id: 'other-tenant' })))).toBe(1452);
      expect(await insert(db, T.events, event({}))).toBeUndefined();
      expect(errnoOf(await insert(db, T.events, event({})))).toBe(1062);
    });

    it('enforces the unique keys for whoever writes them, and lets ended rows coexist', async () => {
      const tenant = 'tenant-unique';
      const make = (patch: Record<string, unknown>) => row({ company_id: tenant, ...patch });
      expect(
        await insert(
          db,
          T.assignments,
          make({ type: 'principal', principal_flag: 1, vehicle_id: 'v1', employee_id: 'e1' }),
        ),
      ).toBeUndefined();
      // second principal of the vehicle, second principal of the driver, second current pair
      expect(
        errnoOf(
          await insert(
            db,
            T.assignments,
            make({ type: 'principal', principal_flag: 1, vehicle_id: 'v1', employee_id: 'e2' }),
          ),
        ),
      ).toBe(1062);
      expect(
        errnoOf(
          await insert(
            db,
            T.assignments,
            make({ type: 'principal', principal_flag: 1, vehicle_id: 'v2', employee_id: 'e1' }),
          ),
        ),
      ).toBe(1062);
      expect(
        errnoOf(await insert(db, T.assignments, make({ vehicle_id: 'v1', employee_id: 'e1' }))),
      ).toBe(1062);
      // other types, other tenant and ended history never collide
      expect(
        await insert(db, T.assignments, make({ vehicle_id: 'v1', employee_id: 'e2' })),
      ).toBeUndefined();
      expect(
        await insert(
          db,
          T.assignments,
          make({
            company_id: 'tenant-unique-2',
            type: 'principal',
            principal_flag: 1,
            vehicle_id: 'v1',
            employee_id: 'e1',
          }),
        ),
      ).toBeUndefined();
      for (let n = 0; n < 3; n += 1)
        expect(
          await insert(
            db,
            T.assignments,
            make({
              type: 'principal',
              vehicle_id: 'v1',
              employee_id: 'e1',
              ended_at: new Date('2026-10-07T00:00:00Z'),
              end_kind: 'ended',
              end_reason: 'Cierre',
              ended_by: ACTOR,
              current_flag: null,
              version: 2,
            }),
          ),
        ).toBeUndefined();
    });

    it('applies the migration in both directions', async () => {
      const counted = await db.rows<{ n: number }>(
        'SELECT COUNT(*) AS n FROM opslog_assignments_migrations',
      );
      expect(counted[0]?.n).toBe(1);
    });
  });

  describe('least privilege', () => {
    it('lets the runtime account read, insert and update assignments, but never delete', async () => {
      const a = assignment('tenant-grants', 'g1');
      await storeA.insert(a, assignedEvent(a));
      const ended = closed(a);
      expect(await storeA.replace(ended, 1, endedEvent(ended))).toBe(true);
      for (const sql of [
        `DELETE FROM ${T.assignments} WHERE company_id = 'tenant-grants'`,
        `DELETE FROM ${T.events} WHERE company_id = 'tenant-grants'`,
        `UPDATE ${T.events} SET reason = 'x' WHERE company_id = 'tenant-grants'`,
        `TRUNCATE TABLE ${T.assignments}`,
        `DROP TABLE ${T.events}`,
        `ALTER TABLE ${T.assignments} ADD COLUMN extra INT`,
      ]) {
        const error = await outcome(sourceA.query(sql));
        expect([sql, errnoOf(error)]).toEqual([sql, expect.any(Number)]);
        expect([1142, 1044, 1143]).toContain(errnoOf(error));
      }
      expect((await storeA.events('tenant-grants', 'g1', window)).total).toBe(2);
      expect(await storeA.find('tenant-grants', 'g1')).toEqual(ended);
    });
  });

  describe('store behaviour on the real database', () => {
    it('round-trips every field, with microsecond timestamps in order', async () => {
      const tenant = 'tenant-roundtrip';
      const first = assignment(tenant, 'r1', {
        vehicleId: 'v1',
        employeeId: 'e1',
        type: 'secondary',
        startedAt: '2026-10-06T12:00:00.123Z',
        updatedAt: '2026-10-06T12:00:00.123Z',
      });
      const second = assignment(tenant, 'r2', {
        vehicleId: 'v1',
        employeeId: 'e2',
        type: 'temporary',
        startedAt: '2026-10-06T12:00:00.124Z',
        updatedAt: '2026-10-06T12:00:00.124Z',
      });
      await storeA.insert(first, assignedEvent(first));
      await storeA.insert(second, assignedEvent(second));
      const ended = closed(first);
      await storeA.replace(ended, 1, endedEvent(ended));
      expect(await storeB.find(tenant, 'r1')).toEqual(ended);
      expect(await storeB.find(tenant, 'r2')).toEqual(second);
      expect((await storeA.list(tenant, {}, window)).items.map((a) => a.id)).toEqual(['r2', 'r1']);
      expect((await storeA.list(tenant, { status: 'current' }, window)).items).toEqual([second]);
      expect((await storeA.list(tenant, { status: 'ended' }, window)).items).toEqual([ended]);
      expect(
        (await storeA.list(tenant, { type: 'temporary', vehicleId: 'v1' }, window)).items,
      ).toEqual([second]);
      expect((await storeA.list(tenant, { employeeId: 'e1' }, window)).items).toEqual([ended]);
      expect((await storeA.events(tenant, 'r1', window)).items.map((e) => e.kind)).toEqual([
        'ended',
        'assigned',
      ]);
      expect(await storeA.list(tenant, {}, { limit: 1, offset: 1 })).toMatchObject({
        total: 2,
        items: [{ id: 'r1' }],
      });
    });

    it('names the conflict a duplicate key means, and writes nothing', async () => {
      const tenant = 'tenant-conflicts';
      const first = assignment(tenant, 'c1');
      await storeA.insert(first, assignedEvent(first));
      const attempt = (a: Assignment) => rejection(storeB.insert(a, assignedEvent(a)));
      expect(await attempt(assignment(tenant, 'c2', { employeeId: 'emp-2' }))).toEqual(
        new AssignmentError('principal_taken', 'vehicle_id'),
      );
      expect(await attempt(assignment(tenant, 'c3', { vehicleId: 'veh-2' }))).toEqual(
        new AssignmentError('principal_taken', 'employee_id'),
      );
      expect(await attempt(assignment(tenant, 'c4', { type: 'secondary' }))).toEqual(
        new AssignmentError('already_assigned', 'employee_id'),
      );
      expect((await storeA.list(tenant, {}, window)).total).toBe(1);
      expect(
        (await db.rows(`SELECT 1 FROM ${T.events} WHERE company_id = ?`, [tenant])).length,
      ).toBe(1);
    });

    it('rolls assignment and event back when local audit append is denied', async () => {
      const tenant = `tenant-audit-${randomUUID()}`;
      const value = assignment(tenant, randomUUID());
      await db.admin.query(
        `REVOKE EXECUTE ON PROCEDURE \`${db.databaseName}\`.\`opslog_append_local_audit_and_delivery\` FROM '${db.runtimeUser}'@'%'`,
      );
      try {
        expect(await rejection(storeA.insert(value, assignedEvent(value)))).toBeInstanceOf(
          AssignmentStoreError,
        );
        for (const table of [T.assignments, T.events])
          expect(
            await db.rows(`SELECT 1 FROM ${table} WHERE company_id = ?`, [tenant]),
          ).toHaveLength(0);
        for (const table of [AUDIT_TABLES.local, AUDIT_TABLES.delivery])
          expect(
            await db.rows(`SELECT event_id FROM ${table} WHERE tenant_id = ?`, [tenant]),
          ).toHaveLength(0);
      } finally {
        await db.admin.query(
          `GRANT EXECUTE ON PROCEDURE \`${db.databaseName}\`.\`opslog_append_local_audit_and_delivery\` TO '${db.runtimeUser}'@'%'`,
        );
      }
    });

    it('replaces the principal atomically and rolls back the whole thing on a clash', async () => {
      const tenant = 'tenant-replace';
      const old = assignment(tenant, 'p1');
      await storeA.insert(old, assignedEvent(old));
      const other = assignment(tenant, 'x1', { vehicleId: 'veh-2', employeeId: 'emp-2' });
      await storeA.insert(other, assignedEvent(other));
      const ended = closed(old, 'replaced');
      const closing = { next: ended, expectedVersion: 1, event: endedEvent(ended) };
      // emp-2 is principal of veh-2: the replacement of veh-1's principal by emp-2 fails whole.
      const clash = assignment(tenant, 'p2', { employeeId: 'emp-2' });
      expect(await rejection(storeA.insert(clash, assignedEvent(clash), closing))).toEqual(
        new AssignmentError('principal_taken', 'employee_id'),
      );
      expect(await storeA.find(tenant, 'p1')).toEqual(old);
      expect(await storeA.find(tenant, 'p2')).toBeNull();
      const swap = assignment(tenant, 'p3', { employeeId: 'emp-3' });
      expect(await storeA.insert(swap, assignedEvent(swap), closing)).toBe(true);
      expect(await storeA.find(tenant, 'p1')).toEqual(ended);
      expect(
        (await storeA.list(tenant, { vehicleId: 'veh-1', status: 'current' }, window)).items,
      ).toEqual([swap]);
      // A stale closing writes nothing.
      const late = assignment(tenant, 'p4', { employeeId: 'emp-4' });
      expect(await storeA.insert(late, assignedEvent(late), closing)).toBe(false);
      expect(await storeA.find(tenant, 'p4')).toBeNull();
    });

    it('never touches the vehicle, driver, type, reason or start of an assignment', async () => {
      const tenant = 'tenant-immutable';
      const a = assignment(tenant, 'i1');
      await storeA.insert(a, assignedEvent(a));
      const ended = {
        ...closed(a),
        vehicleId: 'veh-9',
        employeeId: 'emp-9',
        type: 'temporary' as const,
        reason: 'Otro',
        startedAt: '2000-01-01T00:00:00.000Z',
      };
      expect(await storeA.replace(ended, 1, endedEvent(ended))).toBe(true);
      expect(await storeA.find(tenant, 'i1')).toMatchObject({
        vehicleId: 'veh-1',
        employeeId: 'emp-1',
        type: 'principal',
        reason: 'Alta de unidad',
        startedAt: NOW.toISOString(),
      });
    });

    it('keeps tenants apart on every read and write', async () => {
      const a = assignment('tenant-iso-a', 'same-id');
      const b = assignment('tenant-iso-b', 'same-id');
      await storeA.insert(a, assignedEvent(a));
      await storeA.insert(b, assignedEvent(b));
      expect((await storeA.find('tenant-iso-a', 'same-id'))?.tenantId).toBe('tenant-iso-a');
      expect((await storeA.list('tenant-iso-a', {}, window)).total).toBe(1);
      const ended = closed(a);
      expect(
        await storeA.replace({ ...ended, tenantId: 'tenant-iso-c' }, 1, endedEvent(ended)),
      ).toBe(false);
      expect((await storeA.find('tenant-iso-b', 'same-id'))?.endedAt).toBeNull();
      for (const stored of await db.rows<{ company_id: string }>(
        `SELECT company_id FROM ${T.assignments} WHERE id = 'same-id'`,
      ))
        expect(['tenant-iso-a', 'tenant-iso-b']).toContain(stored.company_id);
    });
  });

  describe('real concurrency across two pools', () => {
    it('lets exactly one of many concurrent principals for a vehicle win', async () => {
      const tenant = 'tenant-race-vehicle';
      const attempts = Array.from({ length: 8 }, (_, n) =>
        (n % 2 === 0 ? svcA : svcB).create(tenant, ACTOR, {
          vehicleId: 'veh-1',
          employeeId: `emp-${n}`,
          type: 'principal',
          reason: 'Carrera',
        }),
      );
      const settled = await Promise.allSettled(attempts);
      expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const result of settled.filter((r) => r.status === 'rejected'))
        expect((result as PromiseRejectedResult).reason).toMatchObject({
          code: 'principal_taken',
          field: 'vehicle_id',
        });
      const rows = await db.rows(`SELECT 1 FROM ${T.assignments} WHERE company_id = ?`, [tenant]);
      expect(rows).toHaveLength(1);
    });

    it('lets exactly one of many concurrent principal vehicles for a driver win', async () => {
      const tenant = 'tenant-race-driver';
      const settled = await Promise.allSettled(
        Array.from({ length: 8 }, (_, n) =>
          (n % 2 === 0 ? svcA : svcB).create(tenant, ACTOR, {
            vehicleId: `veh-${n}`,
            employeeId: 'emp-1',
            type: 'principal',
            reason: 'Carrera',
          }),
        ),
      );
      expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const result of settled.filter((r) => r.status === 'rejected'))
        expect((result as PromiseRejectedResult).reason).toMatchObject({
          code: 'principal_taken',
          field: 'employee_id',
        });
    });

    it('lets exactly one of many concurrent replacements win and leaves one current principal', async () => {
      const tenant = 'tenant-race-replace';
      const first = await svcA.create(tenant, ACTOR, {
        vehicleId: 'veh-1',
        employeeId: 'emp-0',
        type: 'principal',
        reason: 'Alta',
      });
      const settled = await Promise.allSettled(
        Array.from({ length: 8 }, (_, n) =>
          (n % 2 === 0 ? svcA : svcB).create(tenant, ACTOR, {
            vehicleId: 'veh-1',
            employeeId: `emp-${n + 1}`,
            type: 'principal',
            replace: true,
            reason: 'Relevo',
          }),
        ),
      );
      expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const result of settled.filter((r) => r.status === 'rejected'))
        expect(['stale_version', 'principal_taken']).toContain(
          ((result as PromiseRejectedResult).reason as AssignmentError).code,
        );
      const current = await svcA.list(tenant, { vehicleId: 'veh-1', status: 'current' });
      expect(current.total).toBe(1);
      expect((await svcA.get(tenant, first.assignment.id)).endKind).toBe('replaced');
      expect((await svcA.history(tenant, first.assignment.id)).total).toBe(2);
    });

    it('lets exactly one of many concurrent closings win', async () => {
      const tenant = 'tenant-race-end';
      const made = await svcA.create(tenant, ACTOR, {
        vehicleId: 'veh-1',
        employeeId: 'emp-1',
        type: 'secondary',
        reason: 'Alta',
      });
      const settled = await Promise.allSettled(
        Array.from({ length: 8 }, (_, n) =>
          (n % 2 === 0 ? svcA : svcB).end(tenant, ACTOR, made.assignment.id, 1, {
            reason: `Fin ${n}`,
          }),
        ),
      );
      expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const result of settled.filter((r) => r.status === 'rejected'))
        expect(['stale_version', 'immutable']).toContain(
          ((result as PromiseRejectedResult).reason as AssignmentError).code,
        );
      expect((await svcA.history(tenant, made.assignment.id)).total).toBe(2);
    });
  });

  describe('errors', () => {
    it('sanitizes a driver failure: no reason, id or SQL escapes', async () => {
      const broken = new TypeOrmAssignmentStore(sourceA, {
        onError: (event) => events.push(event),
      });
      const a = assignment('tenant-errors', 'e1', { reason: 'Motivo-ficticio-prueba' });
      // A value the CHECK refuses surfaces as an integrity error, without the SQL parameters.
      const bad = { ...a, version: 0 };
      const error = await rejection(broken.insert(bad, assignedEvent(bad)));
      expect(error).toBeInstanceOf(AssignmentStoreError);
      expect(error).toMatchObject({ code: 'integrity', errno: 3819 });
      const text = `${(error as Error).message} ${JSON.stringify(error)} ${JSON.stringify(events)}`;
      for (const fragment of [
        'Motivo-ficticio-prueba',
        'tenant-errors',
        'INSERT INTO',
        'opslog_vehicle_assignments',
      ])
        expect(text).not.toContain(fragment);
    });
  });
});
