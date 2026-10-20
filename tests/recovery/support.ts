import { execFile, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import mysql from 'mysql2/promise';

const run = promisify(execFile);

export const REPO = resolve(import.meta.dirname, '../..');
export const OPS = join(REPO, 'infra/operations');
export const SCRIPTS = {
  backup: join(OPS, 'backup/backup.sh'),
  restore: join(OPS, 'restore/restore.sh'),
  fingerprint: join(OPS, 'restore/fingerprint.sh'),
  tempInstance: join(OPS, 'restore/temp-instance.sh'),
  smoke: join(OPS, 'restore/smoke.mjs'),
} as const;

/** True when the host has what the offline recovery tests need: a second mysqld and the dump tools. */
export function hasTools(): boolean {
  return ['mysqld', 'mysqldump', 'mysqlbinlog', 'mysql', 'mysqladmin'].every(
    (tool) => spawnSync('sh', ['-c', `command -v ${tool}`]).status === 0,
  );
}

export async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolvePort(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

export interface Script {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a script and returns its exit code and output instead of throwing on a non-zero exit. */
export async function script(
  file: string,
  args: readonly string[],
  env: Record<string, string> = {},
): Promise<Script> {
  try {
    const { stdout, stderr } = await run(file, [...args], {
      env: { ...process.env, ...env },
      maxBuffer: 64 << 20,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failed.code === 'number' ? failed.code : 1,
      stdout: failed.stdout ?? '',
      stderr: failed.stderr ?? '',
    };
  }
}

export interface TempInstance {
  readonly name: string;
  readonly port: number;
  readonly root: string;
  admin(): Promise<mysql.Connection>;
  /** Kills the server without a clean shutdown and deletes its data directory: a lost volume. */
  crash(): Promise<void>;
  stop(): Promise<void>;
}

/** Starts a throw-away local mysqld (the `local` driver of temp-instance.sh) on a free port. */
export async function startInstance(
  name: string,
  options: { binlog?: boolean; root?: string } = {},
): Promise<TempInstance> {
  const root = options.root ?? mkdtempSync(join(tmpdir(), 'opslog-recovery-'));
  const port = await freePort();
  const env = {
    OPSLOG_TEMP_ROOT: root,
    OPSLOG_TEMP_MYSQLD_OPTIONS: options.binlog
      ? '--log-bin=binlog --binlog-expire-logs-seconds=604800'
      : '--skip-log-bin',
    OPSLOG_TEMP_SERVER_ID: options.binlog ? '1' : '2',
  };
  const started = await script(SCRIPTS.tempInstance, ['start', name, String(port), 'local'], env);
  if (started.code !== 0)
    throw new Error(`could not start the ${name} instance: ${started.stderr}`);
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await script(SCRIPTS.tempInstance, ['stop', name, 'local'], env);
  };
  return {
    name,
    port,
    root,
    admin: () =>
      mysql.createConnection({ host: '127.0.0.1', port, user: 'root', multipleStatements: true }),
    async crash() {
      stopped = true;
      const pid = (await run('cat', [join(root, name, 'mysqld.pid')])).stdout.trim();
      process.kill(Number(pid), 'SIGKILL');
      await new Promise((r) => setTimeout(r, 500));
      rmSync(join(root, name), { recursive: true, force: true });
    },
    stop,
  };
}
