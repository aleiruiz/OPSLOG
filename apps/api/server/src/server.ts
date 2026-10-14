import type { Server } from 'node:http';
import { createBffHandler, createBffServer, type BffHandler } from '../../bff/src/index.js';
import { InMemoryAuditStore } from '../../../../packages/platform/audit/src/index.js';
import {
  createPlatform,
  FakeOidcVerifier,
  InMemoryTenantStore,
  s3ObjectStorageFromEnv,
  type MysqlPlatform,
} from '../../composition/src/index.js';
import { createCognitoVerifier } from '../../../../packages/platform/auth/src/cognito.js';
import { assertStagingOnly, type RuntimeDescriptor } from '../../../../infra/runtime/src/index.js';
import type { ServerConfig, Env } from './config.js';
import { bootstrapFirstCompany } from './bootstrap.js';
import { openPersistentAdapters } from './persistence.js';
import { startWorkerLoop, type WorkerLoop } from './worker-loop.js';

/** Liveness endpoint for the container health check; answered before the BFF so it needs no session. */
export const HEALTH_PATH = '/healthz';

const HEALTH_RESPONSE = {
  status: 200,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: '{"status":"ok"}',
} as const;

function withHealth(handler: BffHandler): BffHandler {
  return (request) =>
    request.method === 'GET' && request.url === HEALTH_PATH
      ? Promise.resolve(HEALTH_RESPONSE)
      : handler(request);
}

export interface RunningServer {
  readonly server: Server;
  readonly port: number;
  /** Runs one worker tick now; the loop runs the same tick on a timer. */
  tick(): Promise<void>;
  stop(): Promise<void>;
}

const stdout = (line: string): void => void process.stdout.write(`${line}\n`);

/**
 * Composes the platform (in-memory adapters, see docs/operations/DEPLOY_COOLIFY.md), the BFF and the
 * in-process worker loop, and starts listening. Staging only: the guard refuses to start otherwise.
 */
export async function startServer(
  env: Env,
  config: ServerConfig,
  descriptor: RuntimeDescriptor,
  log: (line: string) => void = stdout,
): Promise<RunningServer> {
  assertStagingOnly(env, descriptor);
  const persistent = config.mysql ? await openPersistentAdapters(config.mysql) : undefined;
  try {
    return await listen(env, config, log, persistent);
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
): Promise<RunningServer> {
  const fake = new FakeOidcVerifier();
  const verifier = config.oidc ? createCognitoVerifier(config.oidc) : fake;
  const storage = config.objectStorage === 's3' ? { storage: s3ObjectStorageFromEnv(env) } : {};
  if (persistent && !('storage' in storage))
    log(
      'warning: OPSLOG_PERSISTENCE=mysql with OPSLOG_OBJECT_STORAGE=memory loses file contents on restart',
    );
  const platform = createPlatform({
    verifier,
    issuer: config.oidc?.issuer ?? fake.issuer,
    grantSecret: config.grantSecret,
    environment: 'staging',
    adapters: persistent
      ? { ...persistent.adapters, ...storage }
      : {
          tenants: new InMemoryTenantStore(),
          ...storage,
          audit: new InMemoryAuditStore(),
          // In memory there is no separate projection to relay to; the relay stage is a no-op.
          auditRelay: { runBatch: async () => 0 },
        },
  });
  // Restore the access directory before the bootstrap: after a restart the administrator must sign in.
  if (persistent) log(`restored ${await persistent.hydrate(platform)} active memberships`);
  if (config.bootstrap)
    log(
      await bootstrapFirstCompany(platform, config.oidc?.issuer ?? fake.issuer, config.bootstrap),
    );
  const handler = createBffHandler({
    platform,
    secret: config.bffSecret,
    allowedOrigins: [config.publicOrigin],
    // Only the correlation id, the route id and the error class are ever logged.
    onError: (event) => log(`bff_error ${event.correlationId} ${event.route} ${event.errorClass}`),
  });
  const server = createBffServer(withHealth(handler));
  const worker: WorkerLoop = startWorkerLoop(platform.runtime, log);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  log(`opslog api listening on ${config.host}:${port}`);
  return {
    server,
    port,
    tick: worker.tick,
    stop: async () => {
      await worker.stop();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await persistent?.close();
    },
  };
}
