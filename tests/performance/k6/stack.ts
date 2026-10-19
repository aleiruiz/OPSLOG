import mysql from 'mysql2/promise';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { join } from 'node:path';
import { createBffHandler, createBffServer } from '../../../apps/api/bff/src/index.js';
import { BffCrypto } from '../../../apps/api/bff/src/csrf.js';
import { SESSION_COOKIE } from '../../../apps/api/bff/src/cookies.js';
import {
  buildFleetAccounts,
  createPlatform,
  FakeOidcVerifier,
  InMemoryTenantStore,
  type Platform,
} from '../../../apps/api/composition/src/index.js';
import { bootstrapFirstCompany } from '../../../apps/api/server/src/bootstrap.js';
import { readConfig } from '../../../apps/api/server/src/config.js';
import { readMysqlConfig } from '../../../apps/api/server/src/mysql-config.js';
import { openPersistentAdapters, runMigrate } from '../../../apps/api/server/src/persistence.js';
import { startServer } from '../../../apps/api/server/src/server.js';
import { InMemoryAuditStore } from '../../../packages/platform/audit/src/index.js';
import type { RuntimeDescriptor } from '../../../infra/runtime/src/index.js';
import type { LoadFixture, LoadSession } from './scenario-lib.js';
import { seedCompany, type SeedSize } from './seed.js';

const REPO = join(import.meta.dirname, '../../..');
const SUBJECT = 'load-admin';
const BFF_SECRET = 'load-bff-secret-0123456789-abcdefghijklmnop';
const GRANT_SECRET = 'load-grant-secret-0123456789-abcdefghijklm';
const identifier = (value: string): string => {
  if (!/^[A-Za-z0-9_]+$/.test(value)) throw new Error('unsafe synthetic identifier');
  return `\`${value}\``;
};

export interface LoadStackOptions {
  /** `mysql`: the real server entry point over a MySQL database; `memory`: platform and BFF in this process. */
  readonly backend: 'mysql' | 'memory';
  readonly size: SeedSize;
  /** Sessions to open (virtual users). */
  readonly sessions: number;
  /** MySQL admin URL of a loopback server (backend `mysql`). */
  readonly adminUrl?: string | undefined;
}

export interface LoadStack {
  readonly baseUrl: string;
  /** Counts of the server's `bff_error` events by `route errorClass`: what was behind a 500. */
  serverErrors(): Readonly<Record<string, number>>;
  readonly fixture: LoadFixture;
  readonly backend: 'mysql' | 'memory';
  readonly mysqlVersion?: string | undefined;
  readonly size: SeedSize;
  close(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

/** Opens `count` sessions of the synthetic administrator and returns their cookie and CSRF token. */
async function openSessions(
  platform: Platform,
  verifier: FakeOidcVerifier,
  count: number,
): Promise<LoadSession[]> {
  const crypto = new BffCrypto(BFF_SECRET);
  const sessions: LoadSession[] = [];
  for (let i = 0; i < count; i += 1) {
    const nonce = `load-${i}`;
    const principal = await platform.verifyPrincipal(verifier.issueCode(SUBJECT, nonce), nonce);
    const login =
      principal.ok && principal.value ? await platform.signIn(principal.value) : undefined;
    if (!login?.ok || !login.value) throw new Error('could not open a load session');
    sessions.push({
      cookie: `${SESSION_COOKIE}=${login.value.token}`,
      csrf: crypto.sessionToken(login.value.token),
    });
  }
  return sessions;
}

async function adminOf(platform: Platform, verifier: FakeOidcVerifier): Promise<string> {
  const nonce = 'load-seed';
  const principal = await platform.verifyPrincipal(verifier.issueCode(SUBJECT, nonce), nonce);
  const login =
    principal.ok && principal.value ? await platform.signIn(principal.value) : undefined;
  if (!login?.ok || !login.value) throw new Error('could not sign in the seed administrator');
  return login.value.token;
}

function memoryPlatform(verifier: FakeOidcVerifier, origin?: string): Platform {
  return createPlatform({
    verifier,
    issuer: verifier.issuer,
    grantSecret: GRANT_SECRET,
    environment: 'staging',
    ...(origin ? { publicOrigin: origin } : {}),
    adapters: {
      tenants: new InMemoryTenantStore(),
      audit: new InMemoryAuditStore(),
      auditRelay: { runBatch: async () => 0 },
    },
  });
}

async function startMemory(options: LoadStackOptions): Promise<LoadStack> {
  const verifier = new FakeOidcVerifier();
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const platform = memoryPlatform(verifier, origin);
  const company = await bootstrapFirstCompany(platform, verifier.issuer, {
    companyName: 'Empresa de Carga',
    adminSubject: SUBJECT,
  });
  if (company !== 'bootstrap_created') throw new Error('load company was not created');
  const token = await adminOf(platform, verifier);
  const tenantId = (await platform.sessionDetails(token, 'load-seed')).value?.tenantId as string;
  const seeded = await seedCompany(platform, token, tenantId, options.size);
  const sessions = await openSessions(platform, verifier, options.sessions);
  const server: Server = createBffServer(
    createBffHandler({ platform, secret: BFF_SECRET, allowedOrigins: [origin] }),
  );
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    baseUrl: origin,
    backend: 'memory',
    serverErrors: () => ({}),
    size: options.size,
    fixture: { origin, sessions, ...seeded },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** Keeps the count of the server's error events (code and route only, as the logger writes them). */
function errorCounter(): { write(line: string): void; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  return {
    counts,
    write(line) {
      try {
        const event = JSON.parse(line) as {
          level?: string;
          msg?: string;
          route?: string;
          errorClass?: string;
        };
        if (event.level !== 'error') return;
        const key = `${event.msg ?? 'error'} ${event.route ?? ''} ${event.errorClass ?? ''}`.trim();
        counts[key] = (counts[key] ?? 0) + 1;
      } catch {
        counts['unparsed'] = (counts['unparsed'] ?? 0) + 1;
      }
    },
  };
}

async function startMysql(options: LoadStackOptions): Promise<LoadStack> {
  const url = new URL(options.adminUrl ?? '');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (url.protocol !== 'mysql:' || !['localhost', '127.0.0.1', '::1'].includes(host))
    throw new Error('the load stack needs a loopback MySQL admin URL');
  const admin = {
    host,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username) || 'root',
    password: decodeURIComponent(url.password),
  };
  const suffix = randomBytes(4).toString('hex');
  const database = `opslog_t_load_${suffix}`;
  const tag = `l${suffix.slice(0, 5)}`;
  const piiKey = randomBytes(32).toString('base64');
  const env: Record<string, string> = {
    OPSLOG_MYSQL_HOST: host,
    OPSLOG_MYSQL_PORT: String(admin.port),
    OPSLOG_MYSQL_DATABASE: database,
    OPSLOG_MYSQL_ADMIN_USER: admin.user,
    OPSLOG_MYSQL_ROOT_PASSWORD: admin.password,
    OPSLOG_MYSQL_SECRET: randomBytes(32).toString('base64url'),
    OPSLOG_PII_MASTER_KEY: piiKey,
    OPSLOG_MYSQL_ACCOUNT_TAG: tag,
  };
  const connection = await mysql.createConnection({ ...admin, database: 'mysql' });
  const [versionRows] = await connection.query('SELECT VERSION() AS v');
  const mysqlVersion = (versionRows as { v: string }[])[0]?.v;
  const cleanup = async (): Promise<void> => {
    const accounts = buildFleetAccounts(tag, tag, () => '');
    const users = [
      ...Object.values(accounts.runtime),
      accounts.identity,
      accounts.ops,
      accounts.auditMigrator,
      accounts.filesMigrator,
      accounts.maintenanceMigrator,
    ];
    await connection.query(`DROP DATABASE IF EXISTS ${identifier(database)}`);
    for (const { username } of users)
      await connection.query(`DROP USER IF EXISTS '${username}'@'%'`);
    await connection.end();
  };
  try {
    await runMigrate(env, () => undefined);
    // Seed and open the sessions with a platform of this process; sessions are durable in MySQL.
    const verifier = new FakeOidcVerifier();
    const persistent = await openPersistentAdapters(readMysqlConfig(env));
    let seeded;
    let sessions: LoadSession[];
    try {
      const platform = createPlatform({
        verifier,
        issuer: verifier.issuer,
        grantSecret: GRANT_SECRET,
        environment: 'staging',
        adapters: persistent.adapters,
      });
      await persistent.hydrate(platform);
      await bootstrapFirstCompany(platform, verifier.issuer, {
        companyName: 'Empresa de Carga',
        adminSubject: SUBJECT,
      });
      const token = await adminOf(platform, verifier);
      seeded = await seedCompany(platform, token, persistent.tenantId, options.size);
      // Let the outbox and the audit relay drain before the measured server starts.
      for (let pass = 0; pass < 5; pass += 1)
        for (const job of platform.runtime.jobs.list()) await job.run();
      sessions = await openSessions(platform, verifier, options.sessions);
    } finally {
      await persistent.close();
    }
    // The measured process is the real server entry point, with its worker loop and request log.
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const serverEnv = {
      ...env,
      OPSLOG_ENV: 'staging',
      OPSLOG_PERSISTENCE: 'mysql',
      OPSLOG_PUBLIC_ORIGIN: origin,
      OPSLOG_BFF_SECRET: BFF_SECRET,
      OPSLOG_GRANT_SECRET: GRANT_SECRET,
      OPSLOG_AUTH_MODE: 'synthetic',
      PORT: String(port),
      HOST: '127.0.0.1',
    };
    const descriptor = JSON.parse(
      readFileSync(join(REPO, 'infra/runtime/staging.json'), 'utf8'),
    ) as RuntimeDescriptor;
    const errors = errorCounter();
    const running = await startServer(serverEnv, readConfig(serverEnv), descriptor, (line) =>
      errors.write(line),
    );
    return {
      baseUrl: origin,
      backend: 'mysql',
      serverErrors: () => errors.counts,
      mysqlVersion,
      size: options.size,
      fixture: { origin, sessions, ...seeded },
      close: async () => {
        await running.stop();
        await cleanup();
      },
    };
  } catch (error) {
    await cleanup().catch(() => undefined);
    throw error;
  }
}

/** Starts the stack the load test measures and seeds one company. Synthetic data, loopback only. */
export function startLoadStack(options: LoadStackOptions): Promise<LoadStack> {
  return options.backend === 'mysql' ? startMysql(options) : startMemory(options);
}
