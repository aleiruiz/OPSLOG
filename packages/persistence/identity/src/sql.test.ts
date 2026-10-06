import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { createIdentityDataSource } from './data-source.js';
import { LastAdministratorError } from './errors.js';
import { TypeOrmIdentityStore } from './store.js';
import { T0 } from './test-support/harness.js';

/**
 * Runs the real TypeORM query builders and MySQL SQL generator against a stubbed connection and
 * asserts the exact statements the store sends. It cannot prove runtime locking behaviour (that is
 * `mysql.integration.test.ts`), but it pins the SQL shape: row locks, conditional updates,
 * atomic version increments, isolation level, parameter binding.
 */
type Canned = (sql: string) => Record<string, unknown>[];

const HASH = 'a'.repeat(64);
const row = (prefix: string, values: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(values).map(([key, value]) => [`${prefix}_${key}`, value]));
const membership = (status: string, role: string, identityId = 'i') =>
  row('MembershipEntity', {
    tenant_id: 't',
    identity_id: identityId,
    id: 'm',
    role,
    status,
    created_at: T0,
    activated_at: status === 'pending' ? null : T0,
  });
const identity = (status: string) =>
  row('IdentityEntity', {
    id: 'i',
    status,
    mfa: 'disabled',
    authorization_version: 1,
    created_at: T0,
  });
const lockRow = row('TenantLockEntity', { tenant_id: 't', created_at: T0 });

describe('SQL emitted by the store (real TypeORM builders, stubbed connection)', () => {
  let dataSource: DataSource;
  let store: TypeOrmIdentityStore;
  let statements: { sql: string; params: unknown[] | undefined }[] = [];
  let canned: Canned = () => [];
  const restore: (() => void)[] = [];

  const patch = (target: object, key: string, value: unknown) => {
    const original = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { value, configurable: true, writable: true });
    restore.push(() => {
      if (original) Object.defineProperty(target, key, original);
      else Reflect.deleteProperty(target, key);
    });
  };

  beforeAll(async () => {
    dataSource = createIdentityDataSource({
      host: 'stub',
      port: 3306,
      database: 'stub',
      username: 'opslog_identity_stub',
      password: 'stub',
    });
    const driverProto = Object.getPrototypeOf(dataSource.driver) as object;
    const runnerProto = Object.getPrototypeOf(
      dataSource.driver.createQueryRunner('master'),
    ) as object;
    patch(driverProto, 'connect', async () => undefined);
    patch(driverProto, 'afterConnect', async () => undefined);
    patch(driverProto, 'disconnect', async () => undefined);
    patch(runnerProto, 'connect', async () => ({}));
    patch(runnerProto, 'release', async () => undefined);
    patch(runnerProto, 'query', async (sql: string, params?: unknown[], structured?: boolean) => {
      statements.push({ sql, params });
      const isSelect = sql.startsWith('SELECT');
      const records = isSelect ? canned(sql) : [];
      if (structured)
        return {
          raw: isSelect ? records : { affectedRows: 1, insertId: 0 },
          records,
          affected: isSelect ? undefined : 1,
        };
      return isSelect ? records : { affectedRows: 1 };
    });
    await dataSource.initialize();
    store = new TypeOrmIdentityStore(dataSource, { now: () => T0 });
  });

  afterAll(() => {
    for (const undo of restore.reverse()) undo();
  });

  const run = async (work: () => Promise<unknown>, answers: Canned = () => []) => {
    statements = [];
    canned = answers;
    await work();
    // Collapse column lists so assertions read as the statement shape.
    return statements.map(({ sql }) => sql.replace(/^SELECT .*? FROM/, 'SELECT * FROM'));
  };
  const table = (name: string) => `opslog_identity_${name}`;

  it('revokes a membership under the tenant lock, in a fixed lock order, with an atomic version bump', async () => {
    const sql = await run(
      () => store.revokeMembership('t', 'i'),
      (query) => {
        if (query.includes(table('tenant_locks'))) return [lockRow];
        if (query.includes(table('identities'))) return [identity('active')];
        return query.includes('`role` = ?')
          ? [membership('active', 'admin'), membership('active', 'admin', 'j')]
          : [membership('active', 'admin')];
      },
    );
    expect(sql).toContain('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    expect(sql).toContain('START TRANSACTION');
    expect(sql.at(-1)).toBe('COMMIT');
    const forUpdate = sql.filter((statement) => statement.endsWith('FOR UPDATE'));
    expect(forUpdate.map((statement) => /`(opslog_identity_\w+)`/.exec(statement)?.[1])).toEqual([
      table('tenant_locks'),
      table('identities'),
      table('memberships'),
      table('memberships'),
    ]);
    expect(forUpdate[3]).toContain('`role` = ?');
    expect(sql).toContain(
      `UPDATE \`${table('memberships')}\` SET \`status\` = ? WHERE (\`tenant_id\` = ? AND \`identity_id\` = ?)`,
    );
    expect(sql).toContain(
      `UPDATE \`${table('sessions')}\` SET \`revoked_at\` = ? WHERE (\`tenant_id\` = ? AND \`identity_id\` = ? AND \`revoked_at\` IS NULL)`,
    );
    expect(sql).toContain(
      `UPDATE \`${table('identities')}\` SET \`authorization_version\` = \`authorization_version\` + 1 WHERE \`id\` = ?`,
    );
    // The writes come after every lock was taken.
    expect(sql.findIndex((statement) => statement.startsWith('UPDATE'))).toBeGreaterThan(
      sql.lastIndexOf(forUpdate[3] as string),
    );
  });

  it('refuses the last administrator before writing anything', async () => {
    statements = [];
    canned = (query) =>
      query.includes(table('tenant_locks'))
        ? [lockRow]
        : query.includes(table('identities'))
          ? [identity('active')]
          : [membership('active', 'admin')];
    await expect(store.revokeMembership('t', 'i')).rejects.toBeInstanceOf(LastAdministratorError);
    expect(statements.some(({ sql }) => /^(UPDATE|INSERT|DELETE)/.test(sql))).toBe(false);
    expect(statements.at(-1)?.sql).toBe('ROLLBACK');
  });

  it('binds every value as a parameter (no value is interpolated into the SQL text)', async () => {
    const hostile = "x' OR '1'='1";
    statements = [];
    canned = () => [];
    await store.findExternal(hostile, hostile);
    await store.findMembership(hostile, hostile);
    const joined = statements.map(({ sql }) => sql).join('\n');
    expect(joined).not.toContain("OR '1'");
    expect(statements.every(({ params }) => params?.includes(hostile))).toBe(true);
  });

  it('activates an invitation with row locks and a conditional single-use consume', async () => {
    const sql = await run(
      () => store.activateInvitation(HASH, 'p', 's', T0),
      (query) => {
        if (query.includes(table('invitations')))
          return [
            row('InvitationEntity', {
              id: 'inv',
              tenant_id: 't',
              identity_id: 'i',
              token_hash: HASH,
              expires_at: new Date(T0.getTime() + 1000),
              consumed_at: null,
            }),
          ];
        if (query.includes(table('memberships'))) return [membership('pending', 'viewer')];
        if (query.includes(table('identities'))) return [identity('pending')];
        return [];
      },
    );
    const locked = sql.filter((statement) => statement.endsWith('FOR UPDATE'));
    expect(locked).toHaveLength(2);
    expect(locked[0]).toContain(table('identities'));
    expect(locked[1]).toContain(table('memberships'));
    expect(sql.find((statement) => statement.startsWith('INSERT INTO'))).toContain(
      table('external_identities'),
    );
    expect(sql).toContain(
      `UPDATE \`${table('invitations')}\` SET \`consumed_at\` = ? WHERE (\`id\` = ? AND \`consumed_at\` IS NULL AND \`expires_at\` > ?)`,
    );
    // The consume is the last write, so a lost race rolls everything back.
    expect(sql.filter((statement) => statement.startsWith('UPDATE')).at(-1)).toContain(
      table('invitations'),
    );
  });

  it('consumes a recovery with a conditional update and the version bump in one transaction', async () => {
    const sql = await run(
      () => store.consumeRecovery('r', T0),
      (query) =>
        query.includes(table('recoveries'))
          ? [
              row('RecoveryEntity', {
                id: 'r',
                identity_id: 'i',
                token_hash: HASH,
                issued_at: T0,
                expires_at: T0,
                used_at: null,
                superseded_at: null,
              }),
            ]
          : [identity('active')],
    );
    expect(sql).toContain(
      `UPDATE \`${table('recoveries')}\` SET \`used_at\` = ? WHERE (\`id\` = ? AND \`used_at\` IS NULL AND \`superseded_at\` IS NULL AND \`expires_at\` > ?)`,
    );
    expect(sql.indexOf('START TRANSACTION')).toBeLessThan(
      sql.findIndex((statement) => statement.includes('authorization_version` + 1')),
    );
    expect(sql.at(-1)).toBe('COMMIT');
  });

  it('revokes a session with a single conditional update', async () => {
    const sql = await run(() => store.revokeSession('s', T0));
    expect(sql).toEqual([
      `UPDATE \`${table('sessions')}\` SET \`revoked_at\` = ? WHERE (\`id\` = ? AND \`revoked_at\` IS NULL)`,
    ]);
  });

  it('supersedes older invitations and inserts the new one in the same transaction', async () => {
    const sql = await run(() =>
      store.createInvitationWithRole(
        { id: 'i', status: 'pending', mfa: 'disabled', authorizationVersion: 1, createdAt: T0 },
        {
          id: 'm',
          tenantId: 't',
          identityId: 'i',
          status: 'pending',
          createdAt: T0,
          activatedAt: null,
        },
        {
          id: 'inv',
          tenantId: 't',
          identityId: 'i',
          tokenHash: HASH,
          expiresAt: T0,
          consumedAt: null,
        },
        'admin',
      ),
    );
    expect(sql[0]).toBe('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    expect(sql).toContain(
      `UPDATE \`${table('invitations')}\` SET \`consumed_at\` = ? WHERE (\`tenant_id\` = ? AND \`identity_id\` = ? AND \`consumed_at\` IS NULL)`,
    );
    const inserts = sql.filter((statement) => statement.startsWith('INSERT'));
    expect(inserts.map((statement) => /INTO `(\w+)`/.exec(statement)?.[1])).toEqual([
      table('identities'),
      table('memberships'),
      table('invitations'),
    ]);
    expect(sql.at(-1)).toBe('COMMIT');
  });

  it('creates a custom role under the tenant lock: role, then permissions, in one transaction', async () => {
    const sql = await run(
      () =>
        store.createCustomRole(
          't',
          { id: 'r', name: ' Regional ', permissions: ['view', 'create'] },
          5,
        ),
      (query) => {
        if (query.includes('COUNT(1)')) return [{ cnt: '1' }];
        if (query.includes(table('tenant_locks'))) return [lockRow];
        return [];
      },
    );
    expect(sql[0]).toContain(table('memberships'));
    expect(sql).toContain('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    const transaction = sql.slice(sql.indexOf('START TRANSACTION'));
    expect(transaction[1]).toMatch(/^SELECT \* FROM `opslog_identity_tenant_locks`.*FOR UPDATE$/);
    expect(transaction[2]).toMatch(/^SELECT \* FROM `opslog_identity_roles`/);
    expect(transaction[2]).not.toContain('FOR UPDATE');
    const inserts = transaction.filter((statement) => statement.startsWith('INSERT'));
    expect(inserts.map((statement) => /INTO `(\w+)`/.exec(statement)?.[1])).toEqual([
      table('roles'),
      table('role_permissions'),
      table('role_permissions'),
    ]);
    expect(transaction.at(-1)).toBe('COMMIT');
  });
});
