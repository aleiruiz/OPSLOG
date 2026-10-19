#!/usr/bin/env node
// Smoke test of a restored database: runs the migrate job against the temporary instance (it only
// re-creates the restricted accounts, which live outside the dumped databases), starts the API
// against it in read-only mode (no worker, no bootstrap), makes the instance read-only and checks
// the API still serves.
//
//   node smoke.mjs --bundle <dir with server.mjs and migrate.mjs> --host H --port P --database opslog_t_main
//
// Environment: OPSLOG_MYSQL_SECRET and OPSLOG_PII_MASTER_KEY must be the values of the deployment
// the backup came from (the runtime accounts derive from the first; the second unseals personal
// data); OPSLOG_MYSQL_ROOT_PASSWORD is the temporary instance's root password (empty by default).
// Prints one JSON line with the result and exits 0 only when every check passed.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const bundle = args.get('--bundle');
const host = args.get('--host') ?? '127.0.0.1';
const port = args.get('--port');
const database = args.get('--database') ?? 'opslog_t_main';
const minMemberships = Number(args.get('--min-memberships') ?? '1');
if (!bundle || !port) {
  console.error(
    'usage: smoke.mjs --bundle DIR --port P [--host H] [--database NAME] [--min-memberships N]',
  );
  process.exit(2);
}
for (const file of ['server.mjs', 'migrate.mjs'])
  if (!existsSync(join(bundle, file))) {
    console.error(`missing ${join(bundle, file)}: build it with "node apps/api/server/build.mjs"`);
    process.exit(2);
  }
for (const name of ['OPSLOG_MYSQL_SECRET', 'OPSLOG_PII_MASTER_KEY'])
  if (!process.env[name]) {
    console.error(`${name} is required`);
    process.exit(2);
  }

const checks = [];
const check = (name, ok) => checks.push({ name, ok: Boolean(ok) });
const base = {
  PATH: process.env.PATH,
  OPSLOG_PERSISTENCE: 'mysql',
  OPSLOG_MYSQL_HOST: host,
  OPSLOG_MYSQL_PORT: String(port),
  OPSLOG_MYSQL_DATABASE: database,
  OPSLOG_MYSQL_SECRET: process.env.OPSLOG_MYSQL_SECRET,
};

function run(file, env, timeoutMs = 120_000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(bundle, file)], { env: { ...base, ...env } });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (out += chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

async function sql(statement) {
  // The temporary instance has a root account without a TLS requirement; the mysql client is used
  // so this script needs no dependency.
  return new Promise((resolve) => {
    const child = spawn(
      'mysql',
      ['--host', host, '--port', String(port), '--user', 'root', '--protocol=TCP', '-e', statement],
      {
        env: { ...process.env, MYSQL_PWD: process.env.OPSLOG_MYSQL_ROOT_PASSWORD ?? '' },
      },
    );
    child.on('close', (code) => resolve(code === 0));
  });
}

// 1. Accounts. The migrate job is idempotent and writes no business data.
const migrated = await run('migrate.mjs', {
  OPSLOG_MYSQL_ROOT_PASSWORD: process.env.OPSLOG_MYSQL_ROOT_PASSWORD ?? '',
});
check('migrate_job', migrated.code === 0);

// 2. The API, read-only, on a free port.
const secret = () => randomBytes(32).toString('base64url');
const server = spawn(process.execPath, [join(bundle, 'server.mjs')], {
  env: {
    ...base,
    OPSLOG_ENV: 'staging',
    OPSLOG_PUBLIC_ORIGIN: 'http://localhost:8081',
    OPSLOG_BFF_SECRET: secret(),
    OPSLOG_GRANT_SECRET: secret(),
    OPSLOG_AUTH_MODE: 'synthetic',
    OPSLOG_READ_ONLY: 'true',
    OPSLOG_PII_MASTER_KEY: process.env.OPSLOG_PII_MASTER_KEY,
    PORT: '0',
    HOST: '127.0.0.1',
  },
});
let log = '';
server.stdout.on('data', (chunk) => (log += chunk));
server.stderr.on('data', (chunk) => (log += chunk));
const lines = () =>
  log
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
const deadline = Date.now() + 60_000;
while (
  Date.now() < deadline &&
  !lines().some((e) => e.msg === 'api_listening') &&
  server.exitCode === null
)
  await new Promise((resolve) => setTimeout(resolve, 200));
const listening = lines().find((e) => e.msg === 'api_listening');
check('api_started', listening);
if (listening) {
  // Opening the control plane purges expired sessions (one DELETE), so the instance can only be made
  // read-only after the start. From here on any write the served paths attempted would fail.
  check(
    'instance_read_only',
    await sql('SET GLOBAL super_read_only = ON; SET GLOBAL read_only = ON'),
  );
  const url = `http://127.0.0.1:${listening.port}`;
  const get = async (path) => {
    try {
      return await fetch(url + path);
    } catch {
      return undefined;
    }
  };
  check('healthz_200', (await get('/healthz'))?.status === 200);
  const ready = await get('/readyz');
  check('readyz_200', ready?.status === 200);
  check('bff_csrf_200', (await get('/api/auth/csrf'))?.status === 200);
  const restored = lines().find((e) => e.msg === 'access_restored');
  check(
    `memberships_restored_at_least_${minMemberships}`,
    restored && restored.count >= minMemberships,
  );
}
server.kill('SIGTERM');
await new Promise((resolve) =>
  server.exitCode !== null ? resolve() : server.on('close', resolve),
);
check('no_error_lines', !lines().some((e) => e.level === 'error'));

const ok = checks.every((c) => c.ok);
// On failure, the last lines the API wrote (JSON events, or the one-line error of a failed start).
const tail = ok
  ? undefined
  : log
      .split('\n')
      .filter(Boolean)
      .slice(-6)
      .map((line) => line.slice(0, 300));
console.log(JSON.stringify({ msg: 'restore_smoke', ok, checks, ...(tail ? { tail } : {}) }));
process.exit(ok ? 0 : 1);
