import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import mysql from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { provisionBackupAccount } from '../../apps/api/composition/src/index.js';
import { hasTools, script, SCRIPTS, startInstance, type TempInstance } from './support.js';

// The offline backup and restore scripts against a real (second) mysqld. Opt in with OPSLOG_DRILL=1.
const enabled = process.env.OPSLOG_DRILL === '1' && hasTools();
const suite = enabled ? describe : describe.skip;

const PASSWORD = 'backup-password-for-tests-0123456789';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DAY = 86_400;

suite('backup and restore scripts', () => {
  let source: TempInstance;
  let admin: mysql.Connection;
  const backup = mkdtempSync(join(tmpdir(), 'opslog-backup-'));
  const scratch: TempInstance[] = [];
  const env = (dir = backup) => ({
    OPSLOG_BACKUP_DIR: dir,
    OPSLOG_BACKUP_HOST: '127.0.0.1',
    OPSLOG_BACKUP_PORT: String(source.port),
    OPSLOG_BACKUP_PASSWORD: PASSWORD,
  });
  const sh = (command: string, dir = backup) => script(SCRIPTS.backup, [command], env(dir));
  const rowsOf = async (target: TempInstance, sql: string) => {
    const connection = await target.admin();
    try {
      const [rows] = await connection.query(sql);
      return rows as Record<string, unknown>[];
    } finally {
      await connection.end();
    }
  };
  const restoreInto = async (
    args: string[],
    dir = backup,
  ): Promise<{ target: TempInstance; result: Awaited<ReturnType<typeof script>> }> => {
    const target = await startInstance(`restore${scratch.length}`);
    scratch.push(target);
    const result = await script(SCRIPTS.restore, [
      '--backup-dir',
      dir,
      '--host',
      '127.0.0.1',
      '--port',
      String(target.port),
      ...args,
    ]);
    return { target, result };
  };
  const fingerprint = async (target: TempInstance, extra: string[] = []) =>
    (
      await script(SCRIPTS.fingerprint, [
        '--host',
        '127.0.0.1',
        '--port',
        String(target.port),
        ...extra,
      ])
    ).stdout;

  beforeAll(async () => {
    source = await startInstance('source', { binlog: true });
    admin = await source.admin();
    await admin.query('CREATE DATABASE opslog_t_a; CREATE DATABASE opslog_t_b');
    for (const db of ['a', 'b']) {
      await admin.query(
        `CREATE TABLE opslog_t_${db}.m (id INT PRIMARY KEY AUTO_INCREMENT, v VARCHAR(30) NOT NULL, at TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP(6))`,
      );
      await admin.query(`INSERT INTO opslog_t_${db}.m(v) VALUES ('${db}-1'),('${db}-2')`);
    }
    await admin.query('CREATE PROCEDURE opslog_t_a.noop() BEGIN SELECT 1; END');
    await provisionBackupAccount(admin, PASSWORD);
  }, 120_000);

  afterAll(async () => {
    await admin?.end();
    await source?.stop();
    for (const instance of scratch) await instance.stop();
    rmSync(backup, { recursive: true, force: true });
  }, 120_000);

  it('dumps both databases with a checksum, metadata and the binlog position', async () => {
    const result = await sh('dump');
    expect(result.code).toBe(0);
    const files = readdirSync(join(backup, 'dumps'));
    expect(files.filter((f) => f.endsWith('.sql.gz'))).toHaveLength(1);
    expect(files.filter((f) => f.endsWith('.sha256'))).toHaveLength(2);
    const meta = readFileSync(
      join(backup, 'dumps', files.find((f) => f.endsWith('.meta')) as string),
      'utf8',
    );
    expect(meta).toMatch(/^binlog_file=binlog\.\d+$/m);
    expect(meta).toMatch(/^binlog_pos=\d+$/m);
    expect(meta).toContain('databases=opslog_t_a opslog_t_b');
    // The dump keeps routines.
    const dump = (await script('sh', ['-c', `gzip -dc ${join(backup, 'dumps')}/*.sql.gz`])).stdout;
    expect(dump).toContain('PROCEDURE `noop`');
  }, 60_000);

  it('copies closed binlogs once, each with its checksum, and not the active one', async () => {
    await admin.query("INSERT INTO opslog_t_a.m(v) VALUES ('a-3')");
    const first = await sh('binlogs');
    expect(first.code).toBe(0);
    const uuid = readdirSync(join(backup, 'binlogs'))[0] as string;
    const copied = readdirSync(join(backup, 'binlogs', uuid)).filter((f) => !f.endsWith('.sha256'));
    expect(copied.length).toBeGreaterThanOrEqual(1);
    const active = (
      (await admin.query('SHOW BINARY LOGS')) as unknown as [{ Log_name: string }[]]
    )[0].at(-1)?.Log_name;
    expect(copied).not.toContain(active);
    expect(
      readdirSync(join(backup, 'binlogs', uuid)).filter((f) => f.endsWith('.sha256')),
    ).toHaveLength(copied.length);
    const again = await sh('binlogs');
    expect(again.stderr).toContain('"copied":0');
    expect((await sh('health')).code).toBe(0);
  }, 60_000);

  it('copies a write that lands during the copy even if the system then stays idle', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'opslog-backup-idle-'));
    const wrapper = join(dir, 'mysqlbinlog-wrapper.sh');
    const mark = join(dir, 'wrote');
    // Stands in for mysqlbinlog: on its first call it writes a row (the write "during the copy"),
    // then runs the real tool.
    writeFileSync(
      wrapper,
      `#!/bin/sh
if [ ! -f "${mark}" ]; then
  : > "${mark}"
  env -u MYSQL_PWD mysql --protocol=TCP -h 127.0.0.1 -P ${source.port} -u root -e "INSERT INTO opslog_t_a.m(v) VALUES ('written-during-copy')"
fi
exec mysqlbinlog "$@"
`,
      { mode: 0o755 },
    );
    try {
      const withWrapper = { ...env(dir), MYSQLBINLOG: wrapper };
      expect((await script(SCRIPTS.backup, ['binlogs'], withWrapper)).code).toBe(0);
      expect(existsSync(mark)).toBe(true);
      // No further writes: the next run must still notice the active log is no longer what it saved.
      expect((await script(SCRIPTS.backup, ['binlogs'], env(dir))).code).toBe(0);
      const uuid = readdirSync(join(dir, 'binlogs'))[0] as string;
      const found = await script('sh', [
        '-c',
        `grep -la written-during-copy "${join(dir, 'binlogs', uuid)}"/binlog.[0-9]*`,
      ]);
      expect(found.code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('restores the latest state into a temporary instance and the checksums match the source', async () => {
    await admin.query("INSERT INTO opslog_t_b.m(v) VALUES ('b-3')");
    await sh('binlogs');
    const expected = join(backup, 'expected.tsv');
    writeFileSync(expected, await fingerprint(source));
    const report = join(backup, 'report.txt');
    const { target, result } = await restoreInto(['--expect', expected, '--report', report]);
    expect(result.code).toBe(0);
    expect(readFileSync(report, 'utf8')).toMatch(/verified=yes/);
    expect(await fingerprint(target)).toBe(readFileSync(expected, 'utf8'));
    // Routines survive the round trip.
    expect(await rowsOf(target, "SHOW PROCEDURE STATUS WHERE Db = 'opslog_t_a'")).toHaveLength(1);
  }, 120_000);

  it('reports a mismatch against a different expectation', async () => {
    const wrong = join(backup, 'wrong.tsv');
    writeFileSync(wrong, (await fingerprint(source)).replace(/\t\d+\t/, '\t999\t'));
    const { result } = await restoreInto(['--expect', wrong]);
    expect(result.code).toBe(7);
    expect(result.stderr).toContain('restore_verify_mismatch');
  }, 120_000);

  it('restores to an instant: what was written before it is there, what came after is not', async () => {
    await sleep(1100);
    await admin.query("INSERT INTO opslog_t_a.m(v) VALUES ('before-cut')");
    await sleep(1100);
    const [[cut]] = (await admin.query(
      "SELECT DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%d %H:%i:%s') AS t",
    )) as unknown as [{ t: string }[]];
    await sleep(1200);
    await admin.query("INSERT INTO opslog_t_a.m(v) VALUES ('after-cut')");
    await sh('binlogs');
    const { target, result } = await restoreInto(['--until', (cut as { t: string }).t]);
    expect(result.code).toBe(0);
    const values = (await rowsOf(target, 'SELECT v FROM opslog_t_a.m ORDER BY id')).map((r) => r.v);
    expect(values).toContain('before-cut');
    expect(values).not.toContain('after-cut');
  }, 120_000);

  it('restores a single company and leaves the other out', async () => {
    const { target, result } = await restoreInto(['--database', 'opslog_t_a']);
    if (result.code !== 0) throw new Error(result.stderr);
    const schemas = (
      await rowsOf(
        target,
        "SELECT schema_name AS s FROM information_schema.schemata WHERE schema_name LIKE 'opslog%'",
      )
    ).map((r) => r.s);
    expect(schemas).toEqual(['opslog_t_a']);
    expect(await fingerprint(target, ['--database', 'opslog_t_a'])).toBe(
      await fingerprint(source, ['--database', 'opslog_t_a']),
    );
  }, 120_000);

  it('refuses to run the smoke test unless it is marked --temporary on a loopback host', async () => {
    const plain = await script('node', [
      SCRIPTS.smoke,
      '--bundle',
      '/nonexistent',
      '--port',
      '3306',
    ]);
    expect(plain.code).toBe(2);
    expect(plain.stderr).toContain('refusing to run');
    const remote = await script('node', [
      SCRIPTS.smoke,
      '--temporary',
      '--bundle',
      '/nonexistent',
      '--port',
      '3306',
      '--host',
      'db.example.com',
    ]);
    expect(remote.code).toBe(2);
  });

  it('refuses a target that already holds company databases', async () => {
    const result = await script(SCRIPTS.restore, [
      '--backup-dir',
      backup,
      '--host',
      '127.0.0.1',
      '--port',
      String(source.port),
    ]);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('restore_target_not_empty');
  });

  it('refuses a tampered dump, a tampered binlog and a gap in the binlogs', async () => {
    const copyOf = (name: string) => {
      const dir = join(backup, '..', `${name}-${Date.now()}`);
      cpSync(backup, dir, { recursive: true });
      scratchDirs.push(dir);
      return dir;
    };
    const scratchDirs: string[] = [];
    try {
      const tamperedDump = copyOf('dump');
      const dumpFile = readdirSync(join(tamperedDump, 'dumps')).find((f) =>
        f.endsWith('.sql.gz'),
      ) as string;
      appendFileSync(join(tamperedDump, 'dumps', dumpFile), 'x');
      expect((await restoreInto([], tamperedDump)).result.code).toBe(5);

      const tamperedLog = copyOf('log');
      const uuid = readdirSync(join(tamperedLog, 'binlogs'))[0] as string;
      const logs = readdirSync(join(tamperedLog, 'binlogs', uuid))
        .filter((f) => !f.endsWith('.sha256'))
        .sort();
      appendFileSync(join(tamperedLog, 'binlogs', uuid, logs[0] as string), 'x');
      expect((await restoreInto([], tamperedLog)).result.code).toBe(5);

      const gap = copyOf('gap');
      const gapLogs = readdirSync(join(gap, 'binlogs', uuid))
        .filter((f) => !f.endsWith('.sha256'))
        .sort();
      expect(gapLogs.length).toBeGreaterThanOrEqual(3);
      rmSync(join(gap, 'binlogs', uuid, gapLogs[1] as string));
      rmSync(join(gap, 'binlogs', uuid, `${gapLogs[1]}.sha256`));
      expect((await restoreInto([], gap)).result.code).toBe(6);
    } finally {
      for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
    }
  }, 240_000);

  it('retention deletes what is older than 35 days but never the newest dump or the logs after it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'opslog-retention-'));
    try {
      mkdirSync(join(dir, 'dumps'), { recursive: true });
      mkdirSync(join(dir, 'binlogs', 'uuid-1'), { recursive: true });
      const age = (file: string, days: number) => {
        const when = new Date(Date.now() - days * DAY * 1000);
        writeFileSync(file, 'x');
        utimesSync(file, when, when);
      };
      for (const [stamp, days] of [
        ['20260801T030000Z', 60],
        ['20261001T030000Z', 10],
      ] as const) {
        for (const ext of ['.sql.gz', '.sql.gz.sha256', '.meta', '.meta.sha256'])
          age(join(dir, 'dumps', `opslog-${stamp}${ext}`), days);
      }
      age(join(dir, 'binlogs/uuid-1/binlog.000001'), 45);
      age(join(dir, 'binlogs/uuid-1/binlog.000001.sha256'), 45);
      age(join(dir, 'binlogs/uuid-1/binlog.000009'), 5);
      expect((await sh('retention', dir)).code).toBe(0);
      expect(readdirSync(join(dir, 'dumps')).sort()).toEqual(
        ['.meta', '.meta.sha256', '.sql.gz', '.sql.gz.sha256']
          .map((ext) => `opslog-20261001T030000Z${ext}`)
          .sort(),
      );
      expect(readdirSync(join(dir, 'binlogs/uuid-1'))).toEqual(['binlog.000009']);

      // Backups stalled for 50 days: the last dump and the logs after it are all there is, so they stay.
      const stalled = mkdtempSync(join(tmpdir(), 'opslog-retention-'));
      mkdirSync(join(stalled, 'dumps'), { recursive: true });
      mkdirSync(join(stalled, 'binlogs/uuid-1'), { recursive: true });
      for (const ext of ['.sql.gz', '.sql.gz.sha256', '.meta', '.meta.sha256'])
        age(join(stalled, 'dumps', `opslog-20260901T030000Z${ext}`), 50);
      age(join(stalled, 'binlogs/uuid-1/binlog.000002'), 45);
      expect((await sh('retention', stalled)).code).toBe(0);
      expect(readdirSync(join(stalled, 'dumps'))).toHaveLength(4);
      expect(existsSync(join(stalled, 'binlogs/uuid-1/binlog.000002'))).toBe(true);
      rmSync(stalled, { recursive: true, force: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails clearly without the backup password', async () => {
    const result = await script(SCRIPTS.backup, ['dump'], { ...env(), OPSLOG_BACKUP_PASSWORD: '' });
    expect(result.code).not.toBe(0);
  });
});
