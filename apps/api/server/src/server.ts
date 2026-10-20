import type { Server } from 'node:http';
import {
  checkReadiness,
  createLogger,
  opaqueRef,
  readinessResponse,
  WorkerHeartbeat,
  type Logger,
  type ReadinessResult,
} from '../../../../packages/platform/observability/src/index.js';
import { createBffHandler, createBffServer, type BffHandler } from '../../bff/src/index.js';
import { InMemoryAuditStore } from '../../../../packages/platform/audit/src/index.js';
import {
  createPlatform,
  FakeOidcVerifier,
  InMemoryTenantStore,
  s3ObjectStorageFromEnv,
  type MysqlPlatform,
} from '../../composition/src/index.js';
import { SmtpMailAdapter } from '../../../../packages/platform/mail/src/index.js';
import { createCognitoVerifier } from '../../../../packages/platform/auth/src/cognito.js';
import { assertStagingOnly, type RuntimeDescriptor } from '../../../../infra/runtime/src/index.js';
import type { ServerConfig, Env } from './config.js';
import { bootstrapFirstCompany } from './bootstrap.js';
import { openOpsProbe, openPersistentAdapters } from './persistence.js';
import type { OpsProbe } from './ops.js';
import { exposeActor, withRequestLog } from './request-log.js';
import { startWorkerLoop, type WorkerLoop } from './worker-loop.js';

/** Liveness endpoint for the container health check; answered before the BFF so it needs no session. */
export const HEALTH_PATH = '/healthz';
/** Readiness: database, migrations and worker. The compose health check of `api` uses it; nginx does not publish it. */
export const READY_PATH = '/readyz';

const HEALTH_RESPONSE = {
  status: 200,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: '{"status":"ok"}',
} as const;

function withProbes(
  handler: BffHandler,
  readiness: () => Promise<ReadinessResult>,
  logger: Logger,
): BffHandler {
  return async (request) => {
    if (request.method !== 'GET') return handler(request);
    if (request.url === HEALTH_PATH) return HEALTH_RESPONSE;
    if (request.url !== READY_PATH) return handler(request);
    const result = await readiness();
    if (!result.ready) logger.warn('readyz_failed', { mode: result.code });
    return readinessResponse(result);
  };
}

export interface RunningServer {
  readonly server: Server;
  readonly port: number;
  /** Runs one worker tick now; the loop runs the same tick on a timer. */
  tick(): Promise<void>;
  /** Writes one `ops_stats` line now; the timer writes one every minute. */
  stats(): Promise<void>;
  stop(): Promise<void>;
}

const stdout = (line: string): void => void process.stdout.write(`${line}\n`);

/** One `ops_stats` line per minute (NFR-M3). */
const STATS_INTERVAL_MS = 60_000;

export interface ServerTuning {
  readonly statsIntervalMs?: number;
  readonly tickMs?: number;
}

/**
 * Composes the platform (in-memory adapters, see docs/operations/DEPLOY_COOLIFY.md), the BFF and the
 * in-process worker loop, and starts listening. Staging only: the guard refuses to start otherwise.
 */
export async function startServer(
  env: Env,
  config: ServerConfig,
  descriptor: RuntimeDescriptor,
  log: (line: string) => void = stdout,
  tuning: ServerTuning = {},
): Promise<RunningServer> {
  assertStagingOnly(env, descriptor);
  const persistent = config.mysql ? await openPersistentAdapters(config.mysql) : undefined;
  try {
    return await listen(env, config, log, persistent, tuning);
  } catch (error) {
    await persistent?.close();
    throw error;
  }
}

async function listen(
  env: Env,
  config: ServerConfig,
  log: (line: string) => void,
  persistent: MysqlPlatform | undefined,
  tuning: ServerTuning,
): Promise<RunningServer> {
  const logger = createLogger(
    log,
    persistent ? { companyRef: opaqueRef('c', persistent.tenantId) } : {},
  );
  const fake = new FakeOidcVerifier();
  const verifier = config.oidc ? createCognitoVerifier(config.oidc) : fake;
  const storage = config.objectStorage === 's3' ? { storage: s3ObjectStorageFromEnv(env) } : {};
  if (persistent && !('storage' in storage)) logger.warn('object_storage_memory');
  const mail = config.smtp ? { mail: new SmtpMailAdapter({ config: config.smtp }) } : {};
  const platform = createPlatform({
    verifier,
    issuer: config.oidc?.issuer ?? fake.issuer,
    grantSecret: config.grantSecret,
    environment: 'staging',
    publicOrigin: config.publicOrigin,
    adapters: persistent
      ? { ...persistent.adapters, ...storage, ...mail }
      : {
          tenants: new InMemoryTenantStore(),
          ...storage,
          ...mail,
          audit: new InMemoryAuditStore(),
          // In memory there is no separate projection to relay to; the relay stage is a no-op.
          auditRelay: { runBatch: async () => 0 },
        },
  });
  // Restore the access directory before the bootstrap: after a restart the administrator must sign in.
  if (persistent) logger.info('access_restored', { count: await persistent.hydrate(platform) });
  if (config.readOnly) logger.warn('read_only_mode', { mode: 'read-only' });
  else if (config.bootstrap)
    logger.info(
      await bootstrapFirstCompany(platform, config.oidc?.issuer ?? fake.issuer, config.bootstrap),
    );
  const handler = createBffHandler({
    platform,
    secret: config.bffSecret,
    allowedOrigins: [config.publicOrigin],
    // Only the correlation id, the route id and the error class are ever logged.
    onAuthenticated: exposeActor,
    onError: (event) =>
      logger.error('bff_error', {
        correlationId: event.correlationId,
        route: event.route,
        errorClass: event.errorClass,
      }),
  });
  // Read-only serves a restored database: nothing may write to it, so there is no worker.
  const heartbeat = config.readOnly ? undefined : new WorkerHeartbeat();
  const probe: OpsProbe | undefined = config.mysql ? openOpsProbe(config.mysql) : undefined;
  const readiness = (): Promise<ReadinessResult> =>
    checkReadiness({
      ...(probe ? { database: () => probe.readiness() } : {}),
      ...(heartbeat ? { worker: heartbeat } : {}),
    });
  const server = createBffServer(withRequestLog(withProbes(handler, readiness, logger), logger));
  const worker: WorkerLoop | undefined = heartbeat
    ? startWorkerLoop(platform.runtime, logger, heartbeat, tuning.tickMs)
    : undefined;
  const writeStats = async (): Promise<void> => {
    if (!probe || !heartbeat) return;
    try {
      const counters = await probe.stats();
      logger.info('ops_stats', {
        stats: { ...counters, workerAgeSeconds: Math.floor(heartbeat.ageMs() / 1000) },
      });
    } catch {
      logger.warn('ops_stats_failed');
    }
  };
  const statsTimer = setInterval(
    () => void writeStats(),
    tuning.statsIntervalMs ?? STATS_INTERVAL_MS,
  );
  statsTimer.unref();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  logger.info('api_listening', { port });
  return {
    server,
    port,
    tick: () => worker?.tick() ?? Promise.resolve(),
    stats: writeStats,
    stop: async () => {
      clearInterval(statsTimer);
      await worker?.stop();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await persistent?.close();
    },
  };
}
