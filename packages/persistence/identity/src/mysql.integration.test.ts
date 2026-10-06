import 'reflect-metadata';
import mysql from 'mysql2/promise';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { AuthError, type Identity } from '../../../domain/identity/src/index.js';
import {
  createIdentityDataSource,
  createIdentityMigrationDataSource,
  runIdentityMigrations,
} from './data-source.js';
import { IdentityStoreError, LastAdministratorError } from './errors.js';
import { IDENTITY_CHECKS, IDENTITY_MIGRATION_VERSION } from './migrations.js';
import { BINARY_COLLATION, IDENTITY_TABLES } from './entities.js';
import { ADMIN_ROLE, TypeOrmIdentityStore, type StoreErrorEvent } from './store.js';
import { Clock, HOUR, PROVIDER, T0, createHarness } from './test-support/harness.js';

/**
 * Real MySQL (CI: mysql:8.0.45 service, OPSLOG_TEST_MYSQL_ADMIN_URL). Locally the suite is skipped
 * when the variable is unset; in CI (`CI` set by the runner) a missing variable is a hard failure so
 * the suite can never be skipped silently there. Only synthetic data; the database and the runtime
 * account are created per run and dropped afterwards.
 */
const adminUrlValue = process.env.OPSLOG_TEST_MYSQL_ADMIN_URL;
if (!adminUrlValue && process.env.CI)
  throw new Error(
    'OPSLOG_TEST_MYSQL_ADMIN_URL is required in CI; MySQL integration must not be skipped',
  );
const suite = adminUrlValue ? describe : describe.skip;

function loopbackAdminConfig(value: string) {
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (url.protocol !== 'mysql:' || !['localhost', '127.0.0.1', '::1'].includes(host))
    throw new Error('synthetic MySQL admin URL must use a loopback host');
  return {
    host,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username) || 'root',
    password: decodeURIComponent(url.password),
  };
}

const identifier = (value: string): string => {
  if (!/^[a-zA-Z0-9_]+$/.test(value)) throw new Error('test generated an invalid identifier');
  return `\`${value}\``;
};

class Barrier {
  private waiting = 0;
  private readonly release: Promise<void>;
  private open!: () => void;
  public constructor(private readonly parties: number) {
    this.release = new Promise<void>((resolve) => {
      this.open = resolve;
    });
  }
  public wait(): Promise<void> {
    this.waiting += 1;
    if (this.waiting === this.parties) this.open();
    return this.release;
  }
}

const errnoOf = (error: unknown): number | undefined =>
  (error as { errno?: number; driverError?: { errno?: number } }).driverError?.errno ??
  (error as { errno?: number }).errno;

suite('persistent identity store on MySQL', () => {
  const suffix = `${Date.now()}_${process.pid}`;
  const databaseName = `opslog_idn_${suffix}`;
  const runtimeUser = `opslog_identity_${createHash('sha256').update(suffix).digest('hex').slice(0, 16)}`;
  const runtimePassword = randomBytes(24).toString('base64url');
  const clock = new Clock();
  const events: StoreErrorEvent[] = [];
  let admin: mysql.Connection;
  let adminConfig: ReturnType<typeof loopbackAdminConfig>;
  let sourceA: DataSource;
  let sourceB: DataSource;
  let storeA: TypeOrmIdentityStore;
  let storeB: TypeOrmIdentityStore;
  let h: ReturnType<typeof createHarness>;

  const runtimeConfig = () => ({
    host: adminConfig.host,
    port: adminConfig.port,
    database: databaseName,
    username: runtimeUser,
    password: runtimePassword,
    connectionLimit: 8,
  });
  const newStore = (dataSource: DataSource) =>
    new TypeOrmIdentityStore(dataSource, {
      now: clock.now,
      onError: (event) => events.push(event),
    });
  const rows = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
    const [result] = await admin.query(sql, params);
    return result as T[];
  };
  const tenantId = (): string => randomUUID();

  beforeEach(() => {
    clock.current = new Date(T0);
  });

  beforeAll(async () => {
    adminConfig = loopbackAdminConfig(adminUrlValue as string);
    admin = await mysql.createConnection({ ...adminConfig, database: 'mysql' });
    await admin.query(`CREATE DATABASE ${identifier(databaseName)} CHARACTER SET utf8mb4`);
    await admin.query(`CREATE USER '${runtimeUser}'@'%' IDENTIFIED BY ?`, [runtimePassword]);
    await admin.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ${identifier(databaseName)}.* TO '${runtimeUser}'@'%'`,
    );
    const migrations = createIdentityMigrationDataSource({
      host: adminConfig.host,
      port: adminConfig.port,
      database: databaseName,
      username: adminConfig.user,
      password: adminConfig.password,
    });
    await migrations.initialize();
    try {
      await runIdentityMigrations(migrations);
      expect(await migrations.showMigrations()).toBe(false);
      await migrations.undoLastMigration({ transaction: 'all' });
      expect(await migrations.showMigrations()).toBe(true);
      await runIdentityMigrations(migrations);
      expect(await migrations.showMigrations()).toBe(false);
    } finally {
      await migrations.destroy();
    }
    // Two independent pools stand in for two API processes.
    sourceA = createIdentityDataSource(runtimeConfig());
    sourceB = createIdentityDataSource(runtimeConfig());
    await Promise.all([sourceA.initialize(), sourceB.initialize()]);
    storeA = newStore(sourceA);
    storeB = newStore(sourceB);
    h = createHarness(storeA, clock);
  }, 120_000);

  afterAll(async () => {
    await Promise.allSettled([sourceA?.destroy(), sourceB?.destroy()]);
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${identifier(databaseName)}`);
      await admin.query(`DROP USER IF EXISTS '${runtimeUser}'@'%'`);
      await admin.end();
    }
  }, 60_000);

  describe('schema', () => {
    it('is created, reversible and tracked in its own migrations table', async () => {
      const tables = await rows<{ t: string }>(
        'SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?',
        [databaseName],
      );
      expect(tables.map((row) => row.t).sort()).toEqual(
        [...Object.values(IDENTITY_TABLES), 'opslog_identity_migrations'].sort(),
      );
      const applied = await rows<{ name: string }>(
        `SELECT name FROM ${identifier(databaseName)}.opslog_identity_migrations`,
      );
      expect(applied.map((row) => row.name)).toEqual([
        `CreateIdentityStore${IDENTITY_MIGRATION_VERSION}`,
      ]);
    });

    it('uses a binary NO PAD collation on every key column, with named uniques and foreign keys', async () => {
      const columns = await rows<{ coll: string; table_name: string; column_name: string }>(
        `SELECT COLLATION_NAME AS coll, TABLE_NAME AS table_name, COLUMN_NAME AS column_name
           FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = ? AND DATA_TYPE IN ('varchar', 'char') AND TABLE_NAME <> 'opslog_identity_migrations'`,
        [databaseName],
      );
      expect(columns.length).toBeGreaterThan(20);
      expect(columns.filter((column) => column.coll !== BINARY_COLLATION)).toEqual([]);

      const uniques = await rows<{ name: string }>(
        `SELECT DISTINCT INDEX_NAME AS name FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = ? AND NON_UNIQUE = 0 AND INDEX_NAME <> 'PRIMARY'`,
        [databaseName],
      );
      expect(uniques.map((row) => row.name).sort()).toEqual([
        'uq_identity_external_identity',
        'uq_identity_external_subject',
        'uq_identity_invitations_token',
        'uq_identity_memberships_id',
        'uq_identity_recoveries_token',
        'uq_identity_sessions_token',
      ]);
      const foreignKeys = await rows<{ name: string; ref: string }>(
        `SELECT CONSTRAINT_NAME AS name, REFERENCED_TABLE_NAME AS ref
           FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ?`,
        [databaseName],
      );
      expect(foreignKeys.map((row) => [row.name, row.ref]).sort()).toEqual(
        [
          ['fk_identity_external_identity', IDENTITY_TABLES.identities],
          ['fk_identity_invitations_member', IDENTITY_TABLES.memberships],
          ['fk_identity_memberships_identity', IDENTITY_TABLES.identities],
          ['fk_identity_recoveries_identity', IDENTITY_TABLES.identities],
          ['fk_identity_sessions_member', IDENTITY_TABLES.memberships],
        ].sort(),
      );
      const composite = await rows<{ column_name: string; ref: string }>(
        `SELECT COLUMN_NAME AS column_name, REFERENCED_COLUMN_NAME AS ref
           FROM information_schema.KEY_COLUMN_USAGE
          WHERE TABLE_SCHEMA = ? AND CONSTRAINT_NAME = 'fk_identity_sessions_member'
          ORDER BY ORDINAL_POSITION`,
        [databaseName],
      );
      expect(composite.map((row) => [row.column_name, row.ref])).toEqual([
        ['tenant_id', 'tenant_id'],
        ['identity_id', 'identity_id'],
      ]);
      const checks = await rows<{ name: string }>(
        'SELECT CONSTRAINT_NAME AS name FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ?',
        [databaseName],
      );
      for (const check of IDENTITY_CHECKS)
        expect(checks.map((row) => row.name)).toContain(check.name);
    });

    it('enforces CHECK constraints and denies schema changes to the runtime account', async () => {
      const insertIdentity = (status: string) =>
        sourceA.query(
          `INSERT INTO ${IDENTITY_TABLES.identities}
             (id, status, mfa, authorization_version, created_at) VALUES (?, ?, 'disabled', 1, NOW(6))`,
          [randomUUID(), status],
        );
      await expect(insertIdentity('bogus')).rejects.toSatisfy((e) => errnoOf(e) === 3819);
      await expect(insertIdentity('pending')).resolves.toBeDefined();

      const identityId = randomUUID();
      const tenant = tenantId();
      await sourceA.query(
        `INSERT INTO ${IDENTITY_TABLES.identities}
           (id, status, mfa, authorization_version, created_at) VALUES (?, 'pending', 'disabled', 1, NOW(6))`,
        [identityId],
      );
      const insertMembership = (role: string, status: string, activated: string | null) =>
        sourceA.query(
          `INSERT INTO ${IDENTITY_TABLES.memberships}
             (tenant_id, identity_id, id, role, status, created_at, activated_at)
           VALUES (?, ?, ?, ?, ?, NOW(6), ${activated ? 'NOW(6)' : 'NULL'})`,
          [tenant, identityId, randomUUID(), role, status],
        );
      await expect(insertMembership('Admin', 'pending', null)).rejects.toSatisfy(
        (e) => errnoOf(e) === 3819,
      );
      await expect(insertMembership('admin', 'active', null)).rejects.toSatisfy(
        (e) => errnoOf(e) === 3819,
      );
      await expect(insertMembership('admin', 'active', 'now')).resolves.toBeDefined();

      await expect(sourceA.query('CREATE TABLE forbidden_ddl (id INT)')).rejects.toSatisfy((e) =>
        [1044, 1142].includes(errnoOf(e) ?? 0),
      );
      await expect(sourceA.query(`DROP TABLE ${IDENTITY_TABLES.sessions}`)).rejects.toSatisfy((e) =>
        [1044, 1142].includes(errnoOf(e) ?? 0),
      );
    });
  });

  describe('external identities', () => {
    it('one provider+subject yields one identity even when created from two processes at once', async () => {
      const subject = `race-${randomUUID()}`;
      const barrier = new Barrier(10);
      const candidates = Array.from({ length: 10 }, (_, i) => ({
        store: i % 2 ? storeA : storeB,
        identity: {
          id: randomUUID(),
          status: 'active',
          mfa: 'disabled',
          authorizationVersion: 1,
          createdAt: clock.now(),
        } satisfies Identity,
      }));
      const winners = await Promise.all(
        candidates.map(async ({ store, identity }) => {
          await barrier.wait();
          return store.createExternalIdentity(identity, {
            id: randomUUID(),
            provider: PROVIDER,
            subject,
            identityId: identity.id,
            status: 'active',
            createdAt: clock.now(),
          });
        }),
      );
      expect(new Set(winners.map((winner) => winner.id)).size).toBe(1);
      const stored = await rows<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ${IDENTITY_TABLES.external} WHERE subject = ?`,
        [subject],
      );
      expect(Number(stored[0]?.n)).toBe(1);
      // Losers rolled back their identity rows: no orphan identity remains.
      const identities = await rows<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ${IDENTITY_TABLES.identities} WHERE id IN (${candidates.map(() => '?').join(',')})`,
        candidates.map(({ identity }) => identity.id),
      );
      expect(Number(identities[0]?.n)).toBe(1);
    });

    it('treats subjects as case- and whitespace-sensitive', async () => {
      const base = `Subj-${randomUUID()}`;
      const variants = [base, base.toLowerCase(), `${base} `];
      const ids: string[] = [];
      for (const subject of variants) {
        const identity: Identity = {
          id: randomUUID(),
          status: 'active',
          mfa: 'disabled',
          authorizationVersion: 1,
          createdAt: clock.now(),
        };
        const link = await storeA.createExternalIdentity(identity, {
          id: randomUUID(),
          provider: PROVIDER,
          subject,
          identityId: identity.id,
          status: 'active',
          createdAt: clock.now(),
        });
        ids.push(link.identityId);
        expect(link.identityId).toBe(identity.id);
      }
      expect(new Set(ids).size).toBe(3);
      expect((await storeB.findExternal(PROVIDER, base))?.identityId).toBe(ids[0]);
      expect((await storeB.findExternal(PROVIDER, base.toUpperCase()))?.identityId).toBeUndefined();
    });
  });

  describe('invitations (single use, 72 h)', () => {
    it('activates exactly once under concurrent attempts from two processes', async () => {
      const tenant = tenantId();
      const invited = await h.invite(tenant, 'viewer');
      const barrier = new Barrier(10);
      const results = await Promise.all(
        Array.from({ length: 10 }, async (_, i) => {
          await barrier.wait();
          return (i % 2 ? storeA : storeB).activateInvitation(
            invited.tokenHash,
            PROVIDER,
            `single-use-${invited.identityId}`,
            clock.now(),
          );
        }),
      );
      expect(results.filter((item) => item !== null)).toHaveLength(1);
      expect(await storeA.findMembership(tenant, invited.identityId)).toMatchObject({
        status: 'active',
      });
      const links = await rows<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ${IDENTITY_TABLES.external} WHERE identity_id = ?`,
        [invited.identityId],
      );
      expect(Number(links[0]?.n)).toBe(1);
    });

    it('binds a single subject when different subjects race for one pending identity', async () => {
      const tenant = tenantId();
      const invited = await h.invite(tenant, 'viewer');
      const subjects = ['alice', 'mallory', 'trudy', 'eve'].map(
        (name) => `${name}-${invited.identityId}`,
      );
      const barrier = new Barrier(subjects.length);
      const results = await Promise.all(
        subjects.map(async (subject, i) => {
          await barrier.wait();
          return (i % 2 ? storeA : storeB).activateInvitation(
            invited.tokenHash,
            PROVIDER,
            subject,
            clock.now(),
          );
        }),
      );
      expect(results.filter((item) => item !== null)).toHaveLength(1);
      const links = await rows<{ subject: string }>(
        `SELECT subject FROM ${IDENTITY_TABLES.external} WHERE identity_id = ?`,
        [invited.identityId],
      );
      expect(links).toHaveLength(1);
      expect(subjects).toContain(links[0]?.subject);
    });

    it('expires after 72 hours and a reissue supersedes the older link', async () => {
      const tenant = tenantId();
      const first = await h.service.issueInvitation(tenant);
      expect(first.expiresAt.getTime() - clock.current.getTime()).toBe(72 * HOUR);
      const reissued = await h.service.issueInvitation(tenant, first.identityId);
      await expect(
        h.service.activateInvitation(first.token, PROVIDER, `sub-${first.identityId}`),
      ).rejects.toMatchObject({ code: 'unauthorized' });
      clock.advance(72 * HOUR);
      await expect(
        h.service.activateInvitation(reissued.token, PROVIDER, `sub-${first.identityId}`),
      ).rejects.toMatchObject({ code: 'unauthorized' });
      const fresh = await h.service.issueInvitation(tenant);
      clock.advance(72 * HOUR - 1);
      const activation = await h.service.activateInvitation(
        fresh.token,
        PROVIDER,
        `sub-${fresh.identityId}`,
      );
      expect(activation.membership.status).toBe('active');
      await expect(
        h.service.activateInvitation(fresh.token, PROVIDER, `sub-${fresh.identityId}`),
      ).rejects.toMatchObject({ code: 'unauthorized' });
    });
  });

  describe('sessions, revocation and version bumps', () => {
    it('expires sessions after 8 hours', async () => {
      const tenant = tenantId();
      const member = await h.join(tenant, `sub-${randomUUID()}`, 'viewer');
      const session = await h.login(member.identityId, tenant);
      expect(session.expiresAt.getTime() - clock.current.getTime()).toBe(8 * HOUR);
      clock.advance(8 * HOUR - 1);
      await expect(h.service.authenticate(session.token, 'c')).resolves.toMatchObject({
        tenantId: tenant,
      });
      clock.advance(1);
      await expect(h.service.authenticate(session.token, 'c')).rejects.toMatchObject({
        code: 'unauthorized',
      });
    });

    it('a revoked session is rejected from every process', async () => {
      const tenant = tenantId();
      const member = await h.join(tenant, `sub-${randomUUID()}`, 'viewer');
      const session = await h.login(member.identityId, tenant);
      const other = createHarness(storeB, clock);
      await expect(other.service.authenticate(session.token, 'c')).resolves.toBeDefined();
      await h.service.revoke(session.token);
      await expect(other.service.authenticate(session.token, 'c')).rejects.toMatchObject({
        code: 'unauthorized',
      });
      const stored = await rows<{ revoked_at: Date | null }>(
        `SELECT revoked_at FROM ${IDENTITY_TABLES.sessions} WHERE identity_id = ?`,
        [member.identityId],
      );
      expect(stored).toHaveLength(1);
      expect(stored[0]?.revoked_at).toBeInstanceOf(Date);
      // Only the digest of the token is stored.
      const leaked = await rows<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ${IDENTITY_TABLES.sessions} WHERE token_hash = ?`,
        [session.token],
      );
      expect(Number(leaked[0]?.n)).toBe(0);
    });

    it('removing a member revokes their sessions and bumps the authorization version', async () => {
      const tenant = tenantId();
      await h.join(tenant, `admin-${randomUUID()}`, ADMIN_ROLE);
      const member = await h.join(tenant, `sub-${randomUUID()}`, 'viewer');
      const session = await h.login(member.identityId, tenant);
      expect(await storeB.revokeMembership(tenant, member.identityId)).toBe(true);
      await expect(h.service.authenticate(session.token, 'c')).rejects.toMatchObject({
        code: 'unauthorized',
      });
      expect((await storeA.findIdentity(member.identityId))?.authorizationVersion).toBe(2);
      expect(await storeA.revokeMembership(tenant, member.identityId)).toBe(false);
      const stored = await rows<{ revoked_at: Date | null }>(
        `SELECT revoked_at FROM ${IDENTITY_TABLES.sessions} WHERE identity_id = ?`,
        [member.identityId],
      );
      expect(stored.every((row) => row.revoked_at instanceof Date)).toBe(true);
    });

    it('recovery is consumed once under concurrency and bumps the version exactly once', async () => {
      const tenant = tenantId();
      const member = await h.join(tenant, `sub-${randomUUID()}`, 'viewer');
      const session = await h.login(member.identityId, tenant);
      await h.service.requestRecovery(member.identityId);
      await h.service.settled();
      const delivery = h.deliveries.at(-1);
      if (!delivery) throw new Error('recovery was not delivered');
      const request = await storeA.findRecovery(
        createHash('sha256').update(delivery.token, 'utf8').digest('hex'),
      );
      if (!request) throw new Error('recovery was not stored');
      const barrier = new Barrier(8);
      const outcomes = await Promise.all(
        Array.from({ length: 8 }, async (_, i) => {
          await barrier.wait();
          return (i % 2 ? storeA : storeB).consumeRecovery(request.id, clock.now());
        }),
      );
      expect(outcomes.filter(Boolean)).toHaveLength(1);
      expect((await storeA.findIdentity(member.identityId))?.authorizationVersion).toBe(2);
      await expect(h.service.authenticate(session.token, 'c')).rejects.toMatchObject({
        code: 'unauthorized',
      });
    });
  });

  describe('last administrator', () => {
    const settle = async (promises: Promise<unknown>[]) => {
      const outcomes = await Promise.allSettled(promises);
      const failures = outcomes.filter(
        (item): item is PromiseRejectedResult => item.status === 'rejected',
      );
      // Only the business rule may refuse an operation; a lock timeout/deadlock would be a bug here.
      for (const failure of failures) expect(failure.reason).toBeInstanceOf(LastAdministratorError);
      return outcomes.filter((item) => item.status === 'fulfilled').length;
    };

    it('two concurrent removals of the last two administrators cannot remove both', async () => {
      for (let round = 0; round < 10; round += 1) {
        const tenant = tenantId();
        const a = await h.join(tenant, `a-${randomUUID()}`, ADMIN_ROLE);
        const b = await h.join(tenant, `b-${randomUUID()}`, ADMIN_ROLE);
        const barrier = new Barrier(2);
        const succeeded = await settle([
          barrier.wait().then(() => storeA.revokeMembership(tenant, a.identityId)),
          barrier.wait().then(() => storeB.revokeMembership(tenant, b.identityId)),
        ]);
        expect(succeeded).toBe(1);
        expect(await storeA.countActiveAdmins(tenant)).toBe(1);
      }
    }, 120_000);

    it('removing all of three administrators at once leaves exactly one', async () => {
      const tenant = tenantId();
      const ids = [] as string[];
      for (let i = 0; i < 3; i += 1)
        ids.push((await h.join(tenant, `admin-${i}-${randomUUID()}`, ADMIN_ROLE)).identityId);
      const barrier = new Barrier(3);
      const succeeded = await settle(
        ids.map((id, i) =>
          barrier.wait().then(() => (i % 2 ? storeA : storeB).revokeMembership(tenant, id)),
        ),
      );
      expect(succeeded).toBe(2);
      expect(await storeA.countActiveAdmins(tenant)).toBe(1);
    }, 60_000);

    it('a demotion racing a removal cannot leave the tenant without an administrator', async () => {
      for (let round = 0; round < 5; round += 1) {
        const tenant = tenantId();
        const a = await h.join(tenant, `a-${randomUUID()}`, ADMIN_ROLE);
        const b = await h.join(tenant, `b-${randomUUID()}`, ADMIN_ROLE);
        const barrier = new Barrier(2);
        const succeeded = await settle([
          barrier.wait().then(() => storeA.setRole(tenant, a.identityId, 'viewer')),
          barrier.wait().then(() => storeB.revokeMembership(tenant, b.identityId)),
        ]);
        expect(succeeded).toBe(1);
        expect(await storeA.countActiveAdmins(tenant)).toBe(1);
      }
    }, 120_000);

    it('refuses to remove or demote a sole administrator and counts only active ones', async () => {
      const tenant = tenantId();
      const only = await h.join(tenant, `only-${randomUUID()}`, ADMIN_ROLE);
      await h.invite(tenant, ADMIN_ROLE); // pending: does not count
      await expect(storeA.revokeMembership(tenant, only.identityId)).rejects.toBeInstanceOf(
        LastAdministratorError,
      );
      await expect(storeA.setRole(tenant, only.identityId, 'editor')).rejects.toBeInstanceOf(
        LastAdministratorError,
      );
      expect(await storeA.findRole(tenant, only.identityId)).toBe(ADMIN_ROLE);
      expect((await storeA.findIdentity(only.identityId))?.authorizationVersion).toBe(1);
    });

    it('is enforced through a lock row: a held tenant lock makes the other process wait, then proceed', async () => {
      const tenant = tenantId();
      const a = await h.join(tenant, `a-${randomUUID()}`, ADMIN_ROLE);
      await h.join(tenant, `b-${randomUUID()}`, ADMIN_ROLE);
      // Any admin operation creates the tenant's lock row (a plain viewer removal does).
      const viewer = await h.join(tenant, `v-${randomUUID()}`, 'viewer');
      await storeA.revokeMembership(tenant, viewer.identityId);
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked!: () => void;
      const hasLock = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const holder = sourceB.transaction('READ COMMITTED', async (manager) => {
        await manager.query(
          `SELECT tenant_id FROM ${IDENTITY_TABLES.tenantLocks} WHERE tenant_id = ? FOR UPDATE`,
          [tenant],
        );
        locked();
        await released;
      });
      await hasLock;
      let finished = false;
      const waiting = storeA.revokeMembership(tenant, a.identityId).then((value) => {
        finished = true;
        return value;
      });
      // Deterministic: wait until MySQL reports a transaction blocked on a lock, not a fixed sleep.
      let blocked = 0;
      for (let attempt = 0; attempt < 200 && blocked === 0; attempt += 1) {
        const waits = await rows<{ n: number }>(
          "SELECT COUNT(*) AS n FROM information_schema.INNODB_TRX WHERE trx_state = 'LOCK WAIT'",
        );
        blocked = Number(waits[0]?.n);
        if (blocked === 0) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(blocked).toBeGreaterThan(0);
      expect(finished).toBe(false);
      release();
      await holder;
      expect(await waiting).toBe(true);
      expect(await storeA.countActiveAdmins(tenant)).toBe(1);
    }, 60_000);
  });

  describe('tenant isolation', () => {
    it('keeps memberships, roles, sessions and revocations inside their tenant', async () => {
      const tenantOne = tenantId();
      const tenantTwo = tenantId();
      const adminOne = await h.join(tenantOne, `a1-${randomUUID()}`, ADMIN_ROLE);
      await h.join(tenantOne, `a2-${randomUUID()}`, ADMIN_ROLE);
      const adminTwo = await h.join(tenantTwo, `b1-${randomUUID()}`, ADMIN_ROLE);
      await h.join(tenantTwo, `b2-${randomUUID()}`, ADMIN_ROLE);
      const sharedSubject = `shared-${randomUUID()}`;
      const shared = await h.join(tenantOne, sharedSubject, 'viewer');
      await h.join(tenantTwo, sharedSubject, 'editor', shared.identityId);

      expect(await storeA.findRole(tenantOne, shared.identityId)).toBe('viewer');
      expect(await storeA.findRole(tenantTwo, shared.identityId)).toBe('editor');
      expect(await storeA.findMembership(tenantOne, adminTwo.identityId)).toBeNull();
      expect(await storeA.findMembership(tenantTwo, adminOne.identityId)).toBeNull();

      // Naming tenant one with tenant two's admin touches nothing in tenant two.
      expect(await storeB.revokeMembership(tenantOne, adminTwo.identityId)).toBe(false);
      expect(await storeB.setRole(tenantOne, adminTwo.identityId, 'viewer')).toBe(false);
      expect(await storeA.findRole(tenantTwo, adminTwo.identityId)).toBe(ADMIN_ROLE);
      expect(await storeA.countActiveAdmins(tenantTwo)).toBe(2);

      // A session belongs to one tenant: no membership of the other tenant, no session there (FK).
      const session = await h.login(adminOne.identityId, tenantOne);
      expect((await h.service.authenticate(session.token, 'c')).tenantId).toBe(tenantOne);
      await expect(h.login(adminOne.identityId, tenantTwo)).rejects.toMatchObject({
        code: 'unauthorized',
      });
      expect(await storeA.findMembership(tenantTwo, adminOne.identityId)).toBeNull();

      // Removing the shared user from tenant one leaves their tenant-two membership intact.
      expect(await storeA.revokeMembership(tenantOne, shared.identityId)).toBe(true);
      expect(await storeA.findMembership(tenantTwo, shared.identityId)).toMatchObject({
        status: 'active',
      });
      expect(await storeA.findRole(tenantTwo, shared.identityId)).toBe('editor');
    });

    it('an invitation only activates the membership of its own tenant', async () => {
      const tenantOne = tenantId();
      const tenantTwo = tenantId();
      const one = await h.invite(tenantOne, 'viewer');
      const two = await h.invite(tenantTwo, ADMIN_ROLE);
      const activation = await storeA.activateInvitation(
        one.tokenHash,
        PROVIDER,
        `sub-${one.identityId}`,
        clock.now(),
      );
      expect(activation?.membership.tenantId).toBe(tenantOne);
      expect(await storeA.findMembership(tenantTwo, one.identityId)).toBeNull();
      expect(await storeA.findMembership(tenantTwo, two.identityId)).toMatchObject({
        status: 'pending',
      });
    });

    it('does not block one tenant behind another tenant admin lock', async () => {
      const tenantOne = tenantId();
      const tenantTwo = tenantId();
      const a = await h.join(tenantOne, `a-${randomUUID()}`, ADMIN_ROLE);
      await h.join(tenantOne, `a2-${randomUUID()}`, ADMIN_ROLE);
      const b = await h.join(tenantTwo, `b-${randomUUID()}`, ADMIN_ROLE);
      await h.join(tenantTwo, `b2-${randomUUID()}`, ADMIN_ROLE);
      await storeA.revokeMembership(tenantOne, a.identityId); // creates tenant one's lock row
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked!: () => void;
      const hasLock = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const holder = sourceB.transaction('READ COMMITTED', async (manager) => {
        await manager.query(
          `SELECT tenant_id FROM ${IDENTITY_TABLES.tenantLocks} WHERE tenant_id = ? FOR UPDATE`,
          [tenantOne],
        );
        locked();
        await released;
      });
      await hasLock;
      try {
        expect(await storeA.revokeMembership(tenantTwo, b.identityId)).toBe(true);
      } finally {
        release();
        await holder;
      }
    }, 60_000);
  });

  describe('errors and privacy', () => {
    it('reports failures without SQL, parameters or subjects', async () => {
      const subject = `jane.doe.${randomUUID()}@example.test`;
      const identity: Identity = {
        id: randomUUID(),
        status: 'active',
        mfa: 'disabled',
        authorizationVersion: 1,
        createdAt: clock.now(),
      };
      // Same identity id for a second subject: the primary-key duplicate is a conflict, not a leak.
      await storeA.createExternalIdentity(identity, {
        id: randomUUID(),
        provider: PROVIDER,
        subject,
        identityId: identity.id,
        status: 'active',
        createdAt: clock.now(),
      });
      const error = await storeA
        .createExternalIdentity(identity, {
          id: randomUUID(),
          provider: PROVIDER,
          subject: `${subject}-other`,
          identityId: identity.id,
          status: 'active',
          createdAt: clock.now(),
        })
        .then(
          () => null,
          (caught: unknown) => caught,
        );
      expect(error).toBeInstanceOf(AuthError);
      expect(JSON.stringify(error) + String((error as Error).stack)).not.toContain('example.test');

      // A pool that is gone is an infrastructure failure, reported with a fixed message.
      const closed = createIdentityDataSource(runtimeConfig());
      await closed.initialize();
      const closedStore = newStore(closed);
      await closed.destroy();
      const failure = await closedStore.findExternal(PROVIDER, subject).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(failure).toBeInstanceOf(IdentityStoreError);
      expect((failure as Error).message).not.toContain(subject);
      expect(JSON.stringify(events)).not.toContain('example.test');
      expect(events.at(-1)).toMatchObject({ operation: 'findExternal', code: 'unavailable' });
    });
  });
});
