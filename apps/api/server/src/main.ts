import descriptor from '../../../../infra/runtime/staging.json' with { type: 'json' };
import type { RuntimeDescriptor } from '../../../../infra/runtime/src/index.js';
import { readConfig } from './config.js';
import { startServer } from './server.js';

const fail = (message: string): never => {
  process.stderr.write(`opslog api: ${message}\n`);
  return process.exit(1);
};

try {
  const running = await startServer(
    process.env,
    readConfig(process.env),
    descriptor as RuntimeDescriptor,
  );
  const shutdown = (): void => void running.stop().then(() => process.exit(0));
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
} catch (error) {
  fail(error instanceof Error ? error.message : 'could not start');
}
