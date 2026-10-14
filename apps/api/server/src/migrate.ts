import { runMigrate } from './persistence.js';

const stdout = (line: string): void => void process.stdout.write(`${line}\n`);

try {
  await runMigrate(process.env, stdout);
} catch (error) {
  process.stderr.write(`opslog migrate: ${error instanceof Error ? error.message : 'failed'}\n`);
  process.exit(1);
}
