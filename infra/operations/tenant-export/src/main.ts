import { existsSync, statSync } from 'node:fs';
import { createLogger } from '../../../../packages/platform/observability/src/index.js';
import { EnvelopePiiCipher, LocalDevKms } from '../../../../packages/platform/pii/src/index.js';
import { s3ObjectStorageFromEnv } from '../../../../apps/api/composition/src/object-storage.js';
import { parseArchiveKey } from './archive.js';
import { runExport } from './export.js';
import { MysqlSource } from './mysql-source.js';
import { NO_OBJECTS, storageReader } from './object-reader.js';
import { ExportError } from './types.js';
import { extractArchive, verifyArchive } from './verify.js';

type Env = Readonly<Record<string, string | undefined>>;

const USAGE = `usage:
  tenant-export export  --out DIR --operator HANDLE --reason TICKET [--tenant ID]
  tenant-export verify  --archive FILE
  tenant-export extract --archive FILE --out NEWDIR

environment (export):  OPSLOG_EXPORT_KEY  OPSLOG_PII_MASTER_KEY  OPSLOG_BACKUP_PASSWORD
                       [OPSLOG_EXPORT_HOST OPSLOG_EXPORT_PORT OPSLOG_EXPORT_USER OPSLOG_EXPORT_DATABASE]
                       (default to OPSLOG_MYSQL_HOST / _PORT / _DATABASE, as set in the api container)
                       [OPSLOG_OBJECT_STORAGE=s3 and the OPSLOG_S3_* values]
environment (verify, extract):  OPSLOG_EXPORT_KEY`;

export function parseArgs(argv: readonly string[]): {
  command: string;
  flags: Map<string, string>;
} {
  const [command = '', ...rest] = argv;
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i];
    const value = rest[i + 1];
    if (!name?.startsWith('--') || value === undefined || value.startsWith('--'))
      throw new ExportError('bad_arguments');
    flags.set(name.slice(2), value);
  }
  return { command, flags };
}

function required(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new ExportError('missing_setting');
  return value;
}

const flag = (flags: Map<string, string>, name: string): string => {
  const value = flags.get(name);
  if (!value) throw new ExportError('bad_arguments');
  return value;
};

/** S3 when the deployment uses it; the memory store of a running API cannot be read from another process. */
function objectReaderFor(env: Env) {
  const storage = env['OPSLOG_OBJECT_STORAGE']?.trim() || 'memory';
  if (storage === 's3') return storageReader(s3ObjectStorageFromEnv(env), 's3');
  if (storage === 'memory') return NO_OBJECTS;
  throw new ExportError('bad_arguments');
}

/** Runs one command; returns the process exit code. Output lines are JSON events, never values. */
export async function main(
  argv: readonly string[],
  env: Env,
  write: (line: string) => void,
): Promise<number> {
  const logger = createLogger(write);
  try {
    const { command, flags } = parseArgs(argv);
    if (command === 'verify' || command === 'extract') {
      const key = parseArchiveKey(env['OPSLOG_EXPORT_KEY']);
      const archive = flag(flags, 'archive');
      const report =
        command === 'verify'
          ? await verifyArchive(archive, key)
          : await extractArchive(archive, key, flag(flags, 'out'));
      write(JSON.stringify({ msg: `tenant_${command}`, ...report }));
      return report.ok ? 0 : 1;
    }
    if (command !== 'export') throw new ExportError('bad_arguments');
    const outDir = flag(flags, 'out');
    if (!existsSync(outDir) || !statSync(outDir).isDirectory())
      throw new ExportError('bad_arguments');
    const archiveKey = parseArchiveKey(env['OPSLOG_EXPORT_KEY']);
    const piiKey = required(env, 'OPSLOG_PII_MASTER_KEY');
    if (Buffer.from(piiKey, 'base64').length < 32) throw new ExportError('missing_setting');
    const database =
      env['OPSLOG_EXPORT_DATABASE']?.trim() ||
      env['OPSLOG_MYSQL_DATABASE']?.trim() ||
      'opslog_t_main';
    const objects = objectReaderFor(env);
    const source = await MysqlSource.open({
      host: env['OPSLOG_EXPORT_HOST']?.trim() || env['OPSLOG_MYSQL_HOST']?.trim() || 'mysql',
      port: Number(env['OPSLOG_EXPORT_PORT'] ?? env['OPSLOG_MYSQL_PORT'] ?? '3306'),
      user: env['OPSLOG_EXPORT_USER']?.trim() || 'opslog_backup',
      password: required(env, 'OPSLOG_BACKUP_PASSWORD'),
      database,
    });
    try {
      const result = await runExport({
        source,
        cipher: new EnvelopePiiCipher(LocalDevKms.fromBase64(piiKey, 'staging')),
        objects,
        archiveKey,
        outDir,
        databaseName: database,
        operatorRef: flag(flags, 'operator'),
        reasonRef: flag(flags, 'reason'),
        tenantId: flags.get('tenant'),
        logger,
      });
      write(
        JSON.stringify({
          msg: 'tenant_export_result',
          archive: result.archivePath,
          summary: result.summaryPath,
          sha256: result.archiveSha256,
          complete: result.manifest.complete,
        }),
      );
      return result.manifest.complete ? 0 : 3;
    } finally {
      await source.close();
    }
  } catch (error) {
    const code = error instanceof ExportError ? error.code : 'unexpected_error';
    write(JSON.stringify({ msg: 'tenant_export_error', code }));
    if (code === 'bad_arguments') write(USAGE);
    return error instanceof ExportError && error.code === 'bad_arguments' ? 2 : 1;
  }
}
