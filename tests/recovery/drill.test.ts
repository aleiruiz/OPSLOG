import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type mysql from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readConfig } from '../../apps/api/server/src/config.js';
import { runMigrate } from '../../apps/api/server/src/persistence.js';
import { startServer } from '../../apps/api/server/src/server.js';
import type { RuntimeDescriptor } from '../../infra/runtime/src/index.js';
import { hasTools, REPO, script, SCRIPTS, startInstance, type TempInstance } from './support.js';

/**
 * Recovery drill (SPECS §9.3: RPO <= 15 min, RTO <= 4 h; restore to a temporary instance and extract
 * the validated company). With synthetic data it
 *   1. migrates two companies (A and B) the way the deployment does and writes timestamped marks,
 *   2. takes a dump, keeps writing, copies the binlogs, keeps writing, and loses the whole volume,
 *   3. restores into a temporary instance, checks counts and checksums table by table against the
 *      source at the moment of the last copy, and runs the read-only API smoke test,
 *   4. measures RPO (last mark written minus last mark recovered) and RTO (loss to smoke green),
 *   5. restores only company A into a second temporary instance while the recovered "main" instance
 *      has moved on, copies A back by hand as the runbook says, and checks B did not change.
 * It is local and offline, takes a couple of minutes and is not part of the ordinary CI: run it with
 * `pnpm ops:drill` (OPSLOG_DRILL=1 and OPSLOG_PERF=1). The timing bounds are asserted only with
 * OPSLOG_PERF=1; the measured figures are printed and, with OPSLOG_DRILL_OUT, written as JSON.
 */
const enabled = process.env.OPSLOG_DRILL === '1' && hasTools();
const suite = enabled ? describe : describe.skip;
const PERF = process.env.OPSLOG_PERF === '1';

const RPO_OBJECTIVE_MS = 15 * 60_000;
const RTO_OBJECTIVE_MS = 4 * 3_600_000;
/** How long the source keeps writing before the copy and after it (the second is the RPO exposed). */
const BEFORE_COPY_MS = Number(process.env.OPSLOG_DRILL_BEFORE_COPY_MS ?? 3_000);
const AFTER_COPY_MS = Number(process.env.OPSLOG_DRILL_LOSS_WINDOW_MS ?? 4_000);
/** Synthetic bulk rows per company, so the dump and the replay have something to move. */
const FILLER_ROWS = Number(process.env.OPSLOG_DRILL_FILLER_ROWS ?? 50_000);
const BACKUP_PASSWORD = randomBytes(24).toString('base64url');
const A = 'opslog_t_drill_a';
const B = 'opslog_t_drill_b';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Mark {
  readonly seq: number;
  readonly at: number;
}

/** Writes one numbered mark into each company every few milliseconds; can be paused exactly. */
function startWriter(connection: mysql.Connection) {
  const marks: Mark[] = [];
  let seq = 0;
  let paused = false;
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();
  const loop = (async () => {
    while (!stopped) {
      if (paused) {
        await sleep(5);
        continue;
      }
      seq += 1;
      const current = seq;
      inFlight = (async () => {
        await connection.query(
          `INSERT INTO ${A}.drill_marks (seq, written_at) VALUES (?, NOW(6))`,
          [current],
        );
        await connection.query(
          `INSERT INTO ${B}.drill_marks (seq, written_at) VALUES (?, NOW(6))`,
          [current],
        );
        marks.push({ seq: current, at: Date.now() });
      })();
      await inFlight;
      await sleep(20);
    }
  })();
  return {
    marks,
    async pause() {
      paused = true;
      await inFlight;
    },
    resume() {
      paused = false;
    },
    async stop() {
      stopped = true;
      await loop;
    },
  };
}

suite('recovery drill', () => {
  const root = mkdtempSync(join(tmpdir(), 'opslog-drill-'));
  const backup = join(root, 'backups');
  const instances: TempInstance[] = [];
  const secret = randomBytes(32).toString('base64url');
  const piiKey = randomBytes(32).toString('base64');
  const bundle = join(REPO, 'apps/api/server/bundle');
  const figures: Record<string, number | string> = {};
  let source: TempInstance;
  let admin: mysql.Connection;
  let expectedFingerprint = '';
  let copiedSeq = 0;
  let lastWritten: Mark | undefined;
  let marks: Mark[] = [];
  let recovered: TempInstance;

  const backupEnv = () => ({
    OPSLOG_BACKUP_DIR: backup,
    OPSLOG_BACKUP_HOST: '127.0.0.1',
    OPSLOG_BACKUP_PORT: String(source.port),
    OPSLOG_BACKUP_PASSWORD: BACKUP_PASSWORD,
  });
  const fingerprint = async (target: TempInstance, database?: string) =>
    (
      await script(SCRIPTS.fingerprint, [
        '--host',
        '127.0.0.1',
        '--port',
        String(target.port),
        ...(database ? ['--database', database] : []),
      ])
    ).stdout;
  const query = async (target: TempInstance, sql: string) => {
    const connection = await target.admin();
    try {
      const [rows] = await connection.query(sql);
      return rows as Record<string, unknown>[];
    } finally {
      await connection.end();
    }
  };
  const migrationEnv = (target: TempInstance, database: string) => ({
    OPSLOG_MYSQL_HOST: '127.0.0.1',
    OPSLOG_MYSQL_PORT: String(target.port),
    OPSLOG_MYSQL_DATABASE: database,
    OPSLOG_MYSQL_ROOT_PASSWORD: '',
    OPSLOG_MYSQL_SECRET: secret,
    OPSLOG_PII_MASTER_KEY: piiKey,
    OPSLOG_BACKUP_PASSWORD: BACKUP_PASSWORD,
  });
  const bootstrapCompany = async (
    target: TempInstance,
    database: string,
    name: string,
    sub: string,
  ) => {
    const env = {
      ...migrationEnv(target, database),
      OPSLOG_ENV: 'staging',
      OPSLOG_PERSISTENCE: 'mysql',
      OPSLOG_PUBLIC_ORIGIN: 'http://localhost:8081',
      OPSLOG_BFF_SECRET: 'b'.repeat(32),
      OPSLOG_GRANT_SECRET: 'g'.repeat(32),
      OPSLOG_BOOTSTRAP_COMPANY: name,
      OPSLOG_BOOTSTRAP_ADMIN_SUB: sub,
      PORT: '0',
      HOST: '127.0.0.1',
    };
    const running = await startServer(
      env,
      readConfig(env),
      JSON.parse(
        readFileSync(join(REPO, 'infra/runtime/staging.json'), 'utf8'),
      ) as RuntimeDescriptor,
      () => undefined,
    );
    await running.stop();
  };

  beforeAll(async () => {
    if (!existsSync(join(bundle, 'server.mjs')) || !existsSync(join(bundle, 'migrate.mjs'))) {
      const build = await script('node', [join(REPO, 'apps/api/server/build.mjs')]);
      if (build.code !== 0) throw new Error(`could not build the server bundle: ${build.stderr}`);
    }
    source = await startInstance('drill-source', { binlog: true, root });
    instances.push(source);
    admin = await source.admin();
    for (const [database, name, sub] of [
      [A, 'Empresa Sintetica A', 'sub-drill-a'],
      [B, 'Empresa Sintetica B', 'sub-drill-b'],
    ] as const) {
      await runMigrate(migrationEnv(source, database), () => undefined);
      await bootstrapCompany(source, database, name, sub);
      await admin.query(
        `CREATE TABLE ${database}.drill_marks (seq BIGINT PRIMARY KEY, written_at DATETIME(6) NOT NULL)`,
      );
    }
  }, 300_000);

  afterAll(async () => {
    await admin?.end().catch(() => undefined);
    for (const instance of instances) await instance.stop();
    rmSync(root, { recursive: true, force: true });
  }, 120_000);

  it('backs up, loses the volume, restores into a temporary instance and passes the smoke test', async () => {
    expect((await script(SCRIPTS.backup, ['dump'], backupEnv())).code).toBe(0);
    expect((await script(SCRIPTS.backup, ['binlogs'], backupEnv())).code).toBe(0);

    const writer = startWriter(admin);
    await sleep(BEFORE_COPY_MS);
    // The copy: stop writing for an instant so the source's state is exactly what the copy holds.
    await writer.pause();
    expect((await script(SCRIPTS.backup, ['binlogs'], backupEnv())).code).toBe(0);
    expectedFingerprint = await fingerprint(source);
    copiedSeq = writer.marks.at(-1)?.seq ?? 0;
    expect(copiedSeq).toBeGreaterThan(10);
    writeFileSync(join(root, 'expected.tsv'), expectedFingerprint);
    writer.resume();
    // These writes are in the active binlog only: the loss window, bounded by the copy interval.
    await sleep(AFTER_COPY_MS);
    await writer.stop();
    marks = writer.marks;
    lastWritten = marks.at(-1);
    expect(lastWritten && lastWritten.seq > copiedSeq).toBe(true);
    await admin.end();

    // The loss: the server dies without a clean shutdown and its data directory is gone.
    await source.crash();
    const lostAt = Date.now();

    // Recovery, timed from here: a temporary instance, the restore, the smoke test.
    recovered = await startInstance('drill-restored', { root });
    instances.push(recovered);
    const report = join(root, 'report.txt');
    const restored = await script(SCRIPTS.restore, [
      '--backup-dir',
      backup,
      '--host',
      '127.0.0.1',
      '--port',
      String(recovered.port),
      '--expect',
      join(root, 'expected.tsv'),
      '--report',
      report,
    ]);
    if (restored.code !== 0) throw new Error(restored.stderr);
    expect(readFileSync(report, 'utf8')).toMatch(/verified=yes/);

    const smoke = await script(
      'node',
      [
        SCRIPTS.smoke,
        '--temporary',
        '--bundle',
        bundle,
        '--port',
        String(recovered.port),
        '--database',
        A,
      ],
      {
        OPSLOG_MYSQL_SECRET: secret,
        OPSLOG_PII_MASTER_KEY: piiKey,
        OPSLOG_MYSQL_ROOT_PASSWORD: '',
      },
    );
    const rtoMs = Date.now() - lostAt;
    if (smoke.code !== 0) throw new Error(smoke.stdout + smoke.stderr);
    expect(JSON.parse(smoke.stdout.trim().split('\n').at(-1) as string)).toMatchObject({
      ok: true,
    });

    // What came back: everything up to the copy, nothing after it.
    for (const database of [A, B]) {
      const [{ top, total }] = (await query(
        recovered,
        `SELECT MAX(seq) AS top, COUNT(*) AS total FROM ${database}.drill_marks`,
      )) as [{ top: number; total: number }];
      expect(Number(top)).toBe(copiedSeq);
      expect(Number(total)).toBe(copiedSeq);
    }
    const recoveredMark = marks.find((mark) => mark.seq === copiedSeq) as Mark;
    const rpoMs = (lastWritten as Mark).at - recoveredMark.at;
    Object.assign(figures, {
      mysql: String((await query(recovered, 'SELECT VERSION() AS v'))[0]?.v),
      fillerRowsPerCompany: FILLER_ROWS,
      marksWritten: marks.length,
      marksRecovered: copiedSeq,
      rpoMeasuredSeconds: Math.round(rpoMs / 100) / 10,
      rpoObjectiveSeconds: RPO_OBJECTIVE_MS / 1000,
      rtoMeasuredSeconds: Math.round(rtoMs / 100) / 10,
      rtoObjectiveSeconds: RTO_OBJECTIVE_MS / 1000,
      tablesVerified: Number(/tables=(\d+)/.exec(readFileSync(report, 'utf8'))?.[1]),
    });
    if (PERF) {
      expect(rpoMs).toBeLessThanOrEqual(RPO_OBJECTIVE_MS);
      expect(rtoMs).toBeLessThanOrEqual(RTO_OBJECTIVE_MS);
    }
  }, 600_000);

  it('restoring company A into a temporary instance does not change company B', async () => {
    // The recovered instance becomes the main one: writable again, and it moves on.
    await query(recovered, 'SET GLOBAL super_read_only = OFF; SET GLOBAL read_only = OFF');
    const connection = await recovered.admin();
    await connection.query(
      `INSERT INTO ${B}.drill_marks (seq, written_at) VALUES (1000001, NOW(6)), (1000002, NOW(6))`,
    );
    // A suffers a logical loss (a bad delete); B is healthy and ahead of the backup.
    await connection.query(`DELETE FROM ${A}.drill_marks`);
    const bBefore = await fingerprint(recovered, B);

    const temporary = await startInstance('drill-company-a', { root });
    instances.push(temporary);
    const aExpected =
      expectedFingerprint
        .split('\n')
        .filter((line) => line.startsWith(`${A}\t`))
        .join('\n') + '\n';
    writeFileSync(join(root, 'expected-a.tsv'), aExpected);
    const restored = await script(SCRIPTS.restore, [
      '--backup-dir',
      backup,
      '--host',
      '127.0.0.1',
      '--port',
      String(temporary.port),
      '--database',
      A,
      '--expect',
      join(root, 'expected-a.tsv'),
    ]);
    if (restored.code !== 0) throw new Error(restored.stderr);
    // The temporary instance holds company A and nothing of B.
    expect(
      (
        await query(
          temporary,
          "SELECT schema_name AS s FROM information_schema.schemata WHERE schema_name LIKE 'opslog%'",
        )
      ).map((row) => row.s),
    ).toEqual([A]);

    // The manual step of the runbook: replace A on the main instance with the validated copy.
    await connection.query(`DROP DATABASE ${A}`);
    const copy = await script('sh', [
      '-c',
      `mysqldump --host=127.0.0.1 --port=${temporary.port} --user=root --single-transaction --routines --triggers --databases ${A} | mysql --host=127.0.0.1 --port=${recovered.port} --user=root`,
    ]);
    if (copy.code !== 0) throw new Error(copy.stderr);

    expect(await fingerprint(recovered, A)).toBe(aExpected);
    expect(await fingerprint(recovered, B)).toBe(bBefore);
    expect(
      Number((await query(recovered, `SELECT COUNT(*) AS n FROM ${B}.drill_marks`))[0]?.n),
    ).toBe(copiedSeq + 2);
    await connection.end();
    figures.isolation = 'company B unchanged (fingerprint equal before and after restoring A)';

    if (process.env.OPSLOG_DRILL_OUT)
      writeFileSync(process.env.OPSLOG_DRILL_OUT, `${JSON.stringify(figures, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ msg: 'drill_figures', ...figures })}\n`);
  }, 300_000);
});
