import 'reflect-metadata';
import mysql from 'mysql2/promise';
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { newUploadIntentRecord, validateUpload } from '../../../domain/files/src/index.js';
import { InMemoryAuditStore } from '../../../platform/audit/src/index.js';
import {
  createFileAuditEvent,
  FilePipeline,
  FakeScanner,
  InMemoryObjectStorage,
  refFor,
  type FileActor,
} from '../../../platform/files/src/index.js';
import {
  AUDIT_TABLES,
  createAuditMigrationDataSource,
  runAuditMigrations,
} from '../../audit/src/index.js';
import {
  createFilesDataSource,
  createFilesMigrationDataSource,
  runFilesMigrations,
} from './index.js';
import { FILE_TABLES } from './entities.js';
import { TypeOrmFileSagaStore } from './store.js';

const adminUrl = process.env.OPSLOG_TEST_MYSQL_ADMIN_URL;
if (!adminUrl && process.env.CI)
  throw new Error('OPSLOG_TEST_MYSQL_ADMIN_URL is required in CI; files MySQL tests cannot skip');

function adminConfig(value: string) {
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    url.protocol !== 'mysql:' ||
    (!['localhost', '127.0.0.1', '::1'].includes(host) &&
      process.env.OPSLOG_TEST_MYSQL_ALLOW_REMOTE !== '1')
  )
    throw new Error('synthetic MySQL admin URL must use a loopback host');
  return {
    host,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username) || 'root',
    password: decodeURIComponent(url.password),
  };
}

const ident = (value: string) => {
  if (!/^[A-Za-z0-9_]+$/.test(value)) throw new Error('invalid synthetic MySQL identifier');
  return `\`${value}\``;
};
const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.from('durable-file')]);

describe('tenant-local files saga on MySQL 8', () => {
  let admin: mysql.Connection | undefined;
  let database = '';
  let runtimeUser = '';
  let migrationUsers: string[] = [];
  let runtimePassword = '';
  let runtime: DataSource | undefined;
  let migrationAudit: DataSource | undefined;
  let migrationFiles: DataSource | undefined;
  let store: TypeOrmFileSagaStore | undefined;

  beforeAll(async () => {
    if (!adminUrl) return;
    const suffix = createHash('sha256')
      .update(`${Date.now()}:${randomBytes(12).toString('hex')}`)
      .digest('hex')
      .slice(0, 20);
    database = `opslog_t_${suffix}`;
    const userSuffix = suffix.slice(0, 10);
    runtimeUser = `opslog_files_${userSuffix}`;
    runtimePassword = randomBytes(24).toString('base64url');
    const auditMigratorUser = `opslog_audit_migrator_${userSuffix}`;
    const filesMigratorUser = `opslog_files_migrator_${userSuffix}`;
    migrationUsers = [auditMigratorUser, filesMigratorUser];
    const auditMigratorPassword = randomBytes(24).toString('base64url');
    const filesMigratorPassword = randomBytes(24).toString('base64url');
    admin = await mysql.createConnection({ ...adminConfig(adminUrl), database: 'mysql' });
    const [versionRows] = await admin.query('SELECT VERSION() AS version');
    if (!/^8\./.test((versionRows as { version: string }[])[0]?.version ?? ''))
      throw new Error('files integration requires synthetic MySQL 8');
    const dbConfig = {
      host: adminConfig(adminUrl).host,
      port: adminConfig(adminUrl).port,
      database,
    } as const;
    await admin.query(`CREATE DATABASE ${ident(database)} CHARACTER SET utf8mb4`);
    for (const [user, password] of [
      [runtimeUser, runtimePassword],
      [auditMigratorUser, auditMigratorPassword],
      [filesMigratorUser, filesMigratorPassword],
    ])
      await admin.query(`CREATE USER '${user}'@'%' IDENTIFIED BY ?`, [password]);
    await admin.query(
      `GRANT CREATE, ALTER, INDEX, SELECT, INSERT, REFERENCES, CREATE ROUTINE, ALTER ROUTINE ON ${ident(database)}.* TO '${auditMigratorUser}'@'%'`,
    );
    await admin.query(
      `GRANT CREATE, ALTER, INDEX, SELECT, INSERT, REFERENCES ON ${ident(database)}.* TO '${filesMigratorUser}'@'%'`,
    );
    migrationAudit = createAuditMigrationDataSource({
      ...dbConfig,
      username: auditMigratorUser,
      password: auditMigratorPassword,
    });
    migrationFiles = createFilesMigrationDataSource({
      ...dbConfig,
      username: filesMigratorUser,
      password: filesMigratorPassword,
    });
    await migrationAudit.initialize();
    await runAuditMigrations(migrationAudit);
    await migrationFiles.initialize();
    await runFilesMigrations(migrationFiles);
    const table = (name: string) => `${ident(database)}.${ident(name)}`;
    await admin.query(
      `GRANT SELECT, INSERT, UPDATE ON ${table(FILE_TABLES.records)} TO '${runtimeUser}'@'%'`,
    );
    await admin.query(
      `GRANT SELECT, INSERT ON ${table(FILE_TABLES.history)} TO '${runtimeUser}'@'%'`,
    );
    await admin.query(
      `GRANT SELECT, INSERT, UPDATE ON ${table(FILE_TABLES.saga)} TO '${runtimeUser}'@'%'`,
    );
    await admin.query(`GRANT SELECT ON ${table(AUDIT_TABLES.projection)} TO '${runtimeUser}'@'%'`);
    await admin.query(
      `GRANT EXECUTE ON PROCEDURE ${table('opslog_append_local_audit_and_delivery')} TO '${runtimeUser}'@'%'`,
    );
    runtime = createFilesDataSource({
      ...dbConfig,
      username: runtimeUser,
      password: runtimePassword,
    });
    await runtime.initialize();
    store = new TypeOrmFileSagaStore(runtime, 'tenant-synthetic');
  });

  afterAll(async () => {
    await runtime?.destroy();
    await migrationFiles?.destroy();
    await migrationAudit?.destroy();
    if (admin) {
      if (runtimeUser) await admin.query(`DROP USER IF EXISTS '${runtimeUser}'@'%'`);
      for (const user of migrationUsers) await admin.query(`DROP USER IF EXISTS '${user}'@'%'`);
      if (database) await admin.query(`DROP DATABASE IF EXISTS ${ident(database)}`);
      await admin.end();
    }
  });

  it('survives a released-object failure without rescanning and rolls back if local audit delivery cannot be queued', async () => {
    if (!adminUrl) return;
    if (!admin || !store) throw new Error('files integration fixture was not initialized');
    let currentTime = Date.parse('2026-10-07T12:00:00Z');
    class FailingReleasedWriteStorage extends InMemoryObjectStorage {
      private fail = true;
      public override async putIfAbsent(
        ref: Parameters<InMemoryObjectStorage['putIfAbsent']>[0],
        content: Uint8Array,
        meta: Parameters<InMemoryObjectStorage['putIfAbsent']>[2],
      ): Promise<void> {
        if (ref.area === 'released' && this.fail) {
          this.fail = false;
          throw new Error('synthetic object-store interruption');
        }
        return super.putIfAbsent(ref, content, meta);
      }
    }
    const storage = new FailingReleasedWriteStorage();
    const scanner = new FakeScanner();
    const deps = {
      records: store,
      storage,
      scanner,
      queue: store,
      audit: new InMemoryAuditStore(),
      journal: store,
    };
    const options = {
      now: () => new Date(currentTime),
      newId: () => 'file-durable-1',
      scanBackoffBaseMs: 1,
      scanBackoffMaxMs: 1,
    };
    const pipeline = new FilePipeline(deps, options);
    const actor: FileActor = {
      tenantId: 'tenant-synthetic',
      actorId: 'user-synthetic',
      actorKind: 'user',
      correlationId: 'correlation-synthetic',
    };
    const created = await pipeline.ingestOriginal(actor, {
      name: 'synthetic.jpg',
      declaredType: 'image/jpeg',
      bytes,
    });
    expect(created.status).toBe('pending_scan');
    await expect(store.get('tenant-other', created.id)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect((await pipeline.processScans()).deferred).toBe(1);
    expect(scanner.calls).toBe(1);
    currentTime += 2;
    const restartedWorker = new FilePipeline(deps, options);
    expect((await restartedWorker.processScans()).released).toBe(1);
    expect(scanner.calls).toBe(1);
    expect((await store.get(actor.tenantId, created.id))?.status).toBe('clean');
    expect(await store.getScanOutcome(actor.tenantId, created.id)).toEqual({ result: 'clean' });

    const [historyRows] = await admin.query(
      `SELECT COUNT(*) AS count FROM ${ident(database)}.${ident(FILE_TABLES.history)} WHERE file_id = ?`,
      [created.id],
    );
    expect(Number((historyRows as { count: number | string }[])[0]?.count)).toBe(3);
    const [auditRows] = await admin.query(
      `SELECT COUNT(*) AS count FROM ${ident(database)}.${ident(AUDIT_TABLES.local)} WHERE entity_id = ?`,
      [created.id],
    );
    expect(Number((auditRows as { count: number | string }[])[0]?.count)).toBe(5);

    const table = (name: string) => `${ident(database)}.${ident(name)}`;
    await admin.query(
      `REVOKE EXECUTE ON PROCEDURE ${table('opslog_append_local_audit_and_delivery')} FROM '${runtimeUser}'@'%'`,
    );
    const upload = validateUpload({ name: 'rollback.jpg', declaredType: 'image/jpeg', bytes });
    const rollbackRecord = newUploadIntentRecord({
      id: 'file-rollback-1',
      tenantId: actor.tenantId,
      kind: 'original',
      sensitivity: 'standard',
      upload,
      createdBy: actor.actorId,
      now: new Date(currentTime),
    });
    await expect(
      store.beginUpload(
        rollbackRecord,
        createFileAuditEvent(
          actor,
          'file.upload_requested',
          rollbackRecord.id,
          new Date(currentTime),
        ),
        currentTime + 1000,
      ),
    ).rejects.toBeDefined();
    const [rolledBackRows] = await admin.query(
      `SELECT COUNT(*) AS count FROM ${table(FILE_TABLES.records)} WHERE id = ?`,
      [rollbackRecord.id],
    );
    expect(Number((rolledBackRows as { count: number | string }[])[0]?.count)).toBe(0);
    for (const tableName of [
      FILE_TABLES.history,
      FILE_TABLES.saga,
      AUDIT_TABLES.local,
      AUDIT_TABLES.delivery,
    ]) {
      const [rows] = await admin.query(
        `SELECT COUNT(*) AS count FROM ${table(tableName)} WHERE ${
          tableName === FILE_TABLES.history
            ? 'file_id'
            : tableName === FILE_TABLES.saga
              ? 'file_id'
              : 'event_id'
        } = ?`,
        [
          tableName === AUDIT_TABLES.local || tableName === AUDIT_TABLES.delivery
            ? `files-${rollbackRecord.id}-file.upload_requested`
            : rollbackRecord.id,
        ],
      );
      expect(Number((rows as { count: number | string }[])[0]?.count)).toBe(0);
    }
    await admin.query(
      `GRANT EXECUTE ON PROCEDURE ${table('opslog_append_local_audit_and_delivery')} TO '${runtimeUser}'@'%'`,
    );
  }, 30_000);

  it('recovers a durable quarantine upload after a worker restart', async () => {
    if (!adminUrl) return;
    if (!store) throw new Error('files integration fixture was not initialized');
    const currentTime = Date.parse('2026-10-07T13:00:00Z');
    const actor: FileActor = {
      tenantId: 'tenant-synthetic',
      actorId: 'user-synthetic',
      actorKind: 'user',
      correlationId: 'correlation-upload-recovery',
    };
    const record = newUploadIntentRecord({
      id: 'file-upload-recovery',
      tenantId: actor.tenantId,
      kind: 'original',
      sensitivity: 'standard',
      upload: validateUpload({ name: 'recovered.jpg', declaredType: 'image/jpeg', bytes }),
      createdBy: actor.actorId,
      now: new Date(currentTime),
    });
    const storage = new InMemoryObjectStorage();
    await store.beginUpload(
      record,
      createFileAuditEvent(actor, 'file.upload_requested', record.id, new Date(currentTime)),
      currentTime + 60_000,
    );
    await storage.putIfAbsent(refFor(record, 'quarantine'), bytes, {
      contentType: record.contentType,
      sha256: record.sha256,
    });

    const scanner = new FakeScanner();
    const restartedWorker = new FilePipeline(
      {
        records: store,
        storage,
        scanner,
        queue: store,
        audit: new InMemoryAuditStore(),
        journal: store,
      },
      { now: () => new Date(currentTime) },
    );
    expect((await restartedWorker.processScans()).released).toBe(1);
    expect(scanner.calls).toBe(1);
    expect((await store.get(actor.tenantId, record.id))?.status).toBe('clean');
  }, 30_000);
});
