import { fileURLToPath } from 'node:url';
import { readLandingConfig } from './config.js';
import { startLanding } from './server.js';
import { createFileLeadStore } from './store.js';

const log = (line: string): void => void process.stdout.write(`${line}\n`);

try {
  // In the image the page sits next to the bundle (`/app/public`).
  const config = readLandingConfig(
    process.env,
    fileURLToPath(new URL('./public', import.meta.url)),
  );
  const server = await startLanding({ config, store: createFileLeadStore(config.leadsFile), log });
  log(
    `opslog landing listening on ${config.host}:${config.port}${config.adminPassword ? '' : ' (admin pages off: LANDING_ADMIN_PASSWORD not set)'}`,
  );
  const shutdown = (): void => void server.close(() => process.exit(0));
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
} catch (error) {
  process.stderr.write(
    `opslog landing: ${error instanceof Error ? error.message : 'could not start'}\n`,
  );
  process.exit(1);
}
