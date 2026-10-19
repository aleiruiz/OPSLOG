import mysql from 'mysql2/promise';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createBffWorld, type BffWorld } from '../../../../apps/api/bff/src/test-support.js';
import {
  buildFleetAccounts,
  type MysqlPlatform,
} from '../../../../apps/api/composition/src/index.js';
import { bootstrapFirstCompany } from '../../../../apps/api/server/src/bootstrap.js';
import { readMysqlConfig } from '../../../../apps/api/server/src/mysql-config.js';
import { openPersistentAdapters, runMigrate } from '../../../../apps/api/server/src/persistence.js';
import { InMemoryObjectStorage } from '../../../../packages/platform/files/src/index.js';
import { createLogger } from '../../../../packages/platform/observability/src/index.js';
import { EnvelopePiiCipher, LocalDevKms } from '../../../../packages/platform/pii/src/index.js';
import { CATALOG, dispositionOf } from './catalog.js';
import { runExport } from './export.js';
import { MysqlSource } from './mysql-source.js';
import { storageReader } from './object-reader.js';
import { extractArchive, verifyArchive } from './verify.js';

/**
 * Company export against a real MySQL, composed the way the server composes it (`runMigrate` +
 * `openPersistentAdapters`), with the backup account (SELECT only) as the reader. Needs
 * OPSLOG_TEST_MYSQL_ADMIN_URL (a hard failure in CI); only synthetic data.
 */
const adminUrlValue = process.env.OPSLOG_TEST_MYSQL_ADMIN_URL;
if (!adminUrlValue && process.env.CI)
  throw new Error(
    'OPSLOG_TEST_MYSQL_ADMIN_URL is required in CI; MySQL integration must not be skipped',
  );
const suite = adminUrlValue ? describe : describe.skip;

const TAG = `x${randomBytes(3).toString('hex')}`;
const BACKUP_USER = `opslog_backup_${TAG}`;
const BACKUP_PASSWORD = randomBytes(24).toString('base64url');
const database = `opslog_t_texport_${randomBytes(5).toString('hex')}`;
const piiKey = randomBytes(32).toString('base64');
const archiveKey = randomBytes(32);
const identifier = (value: string): string => {
  if (!/^[A-Za-z0-9_]+$/.test(value)) throw new Error('unsafe synthetic identifier');
  return `\`${value}\``;
};
const JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9,
]);

suite('company export on MySQL', () => {
  const out = mkdtempSync(join(tmpdir(), 'opslog-export-it-'));
  let admin: mysql.Connection;
  let env: Record<string, string>;
  let persistent: MysqlPlatform;
  let world: BffWorld;
  let host = '127.0.0.1';
  let port = 3306;
  const storage = new InMemoryObjectStorage();
  let releasedId = '';

  beforeAll(async () => {
    const url = new URL(adminUrlValue as string);
    host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (url.protocol !== 'mysql:' || !['localhost', '127.0.0.1', '::1'].includes(host))
      throw new Error('synthetic MySQL admin URL must use a loopback host');
    port = Number(url.port || 3306);
    const connection = {
      host,
      port,
      user: decodeURIComponent(url.username) || 'root',
      password: decodeURIComponent(url.password),
    };
    admin = await mysql.createConnection({ ...connection, database: 'mysql' });
    env = {
      OPSLOG_MYSQL_HOST: host,
      OPSLOG_MYSQL_PORT: String(port),
      OPSLOG_MYSQL_DATABASE: database,
      OPSLOG_MYSQL_ADMIN_USER: connection.user,
      OPSLOG_MYSQL_ROOT_PASSWORD: connection.password,
      OPSLOG_MYSQL_SECRET: randomBytes(32).toString('base64url'),
      OPSLOG_PII_MASTER_KEY: piiKey,
      OPSLOG_BACKUP_PASSWORD: BACKUP_PASSWORD,
      OPSLOG_MYSQL_ACCOUNT_TAG: TAG,
      OPSLOG_BACKUP_USER: BACKUP_USER,
    };
    await runMigrate(env, () => undefined);

    vi.useFakeTimers({ toFake: ['Date'] });
    persistent = await openPersistentAdapters(readMysqlConfig(env));
    world = createBffWorld({ adapters: { ...persistent.adapters, storage } });
    await persistent.hydrate(world.platform);
    await bootstrapFirstCompany(world.platform, world.verifier.issuer, {
      companyName: 'Empresa Exportada',
      adminSubject: 'subject-admin',
    });
    const browser = await world.loginAs('subject-admin');
    const area = await browser.post('/api/areas', {
      json: { name: 'Flota Norte', code: null, parentId: null, responsibleIds: [] },
    });
    expect(area.status).toBe(201);
    for (const n of [1, 2, 3])
      expect(
        (
          await browser.post('/api/vehicles', {
            json: {
              economicNumber: `EXP-00${n}`,
              plate: `EXP00${n}`,
              vin: null,
              make: 'Toyota',
              model: 'Hilux',
              year: 2022,
              areaId: area.json.id,
              odometerKm: n,
            },
          })
        ).status,
      ).toBe(201);
    const driver = await browser.post('/api/employees', {
      json: {
        kind: 'driver',
        firstName: 'Ana',
        lastName: 'Exportada',
        areaId: area.json.id,
        employeeNumber: 'EXP-EMP-1',
        idType: 'ine',
        nationalId: 'SYNTH-ID-EXPORT',
        phone: '+525552000002',
        email: 'exportada@synthetic.example',
        licenseNumber: 'LIC-EXP',
        licenseType: 'c',
        licenseExpiresOn: '2099-12-31',
      },
    });
    expect(driver.status).toBe(201);
    const token = (await world.platform.signIn(await world.principal('subject-admin'))).value
      ?.token as string;
    const released = await world.platform.files.upload(token, 'corr-file-1', {
      name: 'evidencia.jpg',
      contentType: 'image/jpeg',
      bytes: JPEG,
    });
    releasedId = released.value?.id as string;
    await world.platform.runtime.runScans();
    // A second upload that the scan has not released: it must not be exported.
    await world.platform.files.upload(token, 'corr-file-2', {
      name: 'pendiente.jpg',
      contentType: 'image/jpeg',
      bytes: new Uint8Array([...JPEG, 0, 0]),
    });
    await world.platform.runtime.runAuditRelay();
  }, 240_000);

  afterAll(async () => {
    world?.dispose();
    await persistent?.close();
    rmSync(out, { recursive: true, force: true });
    if (!admin) return;
    const accounts = buildFleetAccounts(TAG, TAG, () => '');
    const users = [
      ...Object.values(accounts.runtime),
      accounts.identity,
      accounts.ops,
      accounts.auditMigrator,
      accounts.filesMigrator,
      accounts.maintenanceMigrator,
      { username: BACKUP_USER },
    ];
    await admin.query(`DROP DATABASE IF EXISTS ${identifier(database)}`);
    for (const { username } of users) await admin.query(`DROP USER IF EXISTS '${username}'@'%'`);
    await admin.end();
  }, 60_000);

  const exportCompany = async () => {
    const source = await MysqlSource.open({
      host,
      port,
      user: BACKUP_USER,
      password: BACKUP_PASSWORD,
      database,
    });
    try {
      return await runExport({
        source,
        cipher: new EnvelopePiiCipher(LocalDevKms.fromBase64(piiKey, 'staging')),
        objects: storageReader(storage, 'memory'),
        archiveKey,
        outDir: out,
        databaseName: database,
        operatorRef: 'op-it',
        reasonRef: 'TICKET-IT',
        logger: createLogger(() => undefined),
      });
    } finally {
      await source.close();
    }
  };

  it('classifies every table and every sealed or secret column of the migrated schema', async () => {
    const [tables] = await admin.query(
      'SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = ?',
      [database, 'BASE TABLE'],
    );
    for (const { name } of tables as { name: string }[])
      expect(dispositionOf(name), name).toBeDefined();
    // The catalog names no table that does not exist (a renamed table must not linger in it).
    const present = new Set((tables as { name: string }[]).map((t) => t.name));
    for (const name of Object.keys(CATALOG)) expect(present.has(name), name).toBe(true);
    // Any column that holds an envelope or a keyed hash is either opened or left out on purpose.
    const [columns] = await admin.query(
      "SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND (COLUMN_NAME LIKE '%\\_enc' OR COLUMN_NAME LIKE '%\\_sealed' OR COLUMN_NAME LIKE '%\\_idx')",
      [database],
    );
    for (const { t, c } of columns as { t: string; c: string }[]) {
      const spec = dispositionOf(t);
      if (spec?.kind !== 'export') continue;
      const handled =
        (spec.sealed ?? []).some((s) => s.column === c) || (spec.omit ?? []).includes(c);
      expect(handled, `${t}.${c}`).toBe(true);
    }
  });

  it('exports the company with the read-only backup account and the archive verifies', async () => {
    const result = await exportCompany();
    expect(result.manifest.complete).toBe(true);
    const report = await verifyArchive(result.archivePath, archiveKey);
    expect(report).toMatchObject({ ok: true, complete: true });

    // Re-reading the data gives the counts the database has now (no write happened in between).
    for (const entity of result.manifest.entities) {
      const [rows] = await admin.query(
        `SELECT COUNT(*) AS n FROM ${identifier(database)}.${identifier(entity.table)}`,
      );
      expect(entity.rows, entity.table).toBe(Number((rows as { n: number }[])[0]?.n));
    }
    const counts = new Map(result.manifest.entities.map((e) => [e.table, e.rows]));
    expect(counts.get('opslog_vehicles')).toBe(3);
    expect(counts.get('opslog_employees')).toBe(1);
    expect(counts.get('opslog_files')).toBe(2);
    expect(result.manifest.objects).toMatchObject({
      included: 1,
      notReleased: 1,
      missing: [],
      corrupt: [],
    });
  }, 120_000);

  it('extracts personal data in clear only, without sessions, tokens, blind indexes or secrets', async () => {
    const result = await exportCompany();
    const plain = join(out, `plain-${randomBytes(3).toString('hex')}`);
    await extractArchive(result.archivePath, archiveKey, plain);
    const employees = JSON.parse(
      readFileSync(join(plain, 'entities/opslog_employees.json'), 'utf8'),
    ) as Record<string, unknown>[];
    expect(employees[0]).toMatchObject({
      first_name: 'Ana',
      national_id: 'SYNTH-ID-EXPORT',
      phone: '+525552000002',
      email: 'exportada@synthetic.example',
      license_number: 'LIC-EXP',
    });
    expect(Object.keys(employees[0] as object)).not.toEqual(
      expect.arrayContaining(['national_id_idx', 'email_idx', 'national_id_enc']),
    );
    expect(readFileSync(join(plain, `objects/originals/${releasedId}`))).toEqual(Buffer.from(JPEG));

    // Nothing that authenticates a session leaves the database.
    const everything = readdirSync(join(plain, 'entities'))
      .map((f) => readFileSync(join(plain, 'entities', f), 'utf8'))
      .join('\n');
    const [sessions] = await admin.query(
      `SELECT token_hash FROM ${identifier(database)}.opslog_identity_sessions`,
    );
    expect((sessions as unknown[]).length).toBeGreaterThan(0);
    for (const { token_hash: hash } of sessions as { token_hash: string }[])
      expect(everything).not.toContain(hash);
    expect(statSync(result.archivePath).mode & 0o077).toBe(0);
    // The sealed archive itself holds none of the clear text.
    expect(readFileSync(result.archivePath).includes('SYNTH-ID-EXPORT')).toBe(false);
  }, 120_000);

  it('cannot write: the backup account is read-only', async () => {
    const connection = await mysql.createConnection({
      host,
      port,
      user: BACKUP_USER,
      password: BACKUP_PASSWORD,
      database,
    });
    try {
      await expect(connection.query('DELETE FROM opslog_vehicles')).rejects.toMatchObject({
        code: 'ER_TABLEACCESS_DENIED_ERROR',
      });
    } finally {
      await connection.end();
    }
  });
});
