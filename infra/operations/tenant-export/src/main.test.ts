import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../../../../packages/platform/observability/src/index.js';
import { EnvelopePiiCipher, LocalDevKms } from '../../../../packages/platform/pii/src/index.js';
import { runExport } from './export.js';
import { main, parseArgs } from './main.js';
import { NO_OBJECTS } from './object-reader.js';
import { FakeSource, TENANT, table } from './test-support/fake-source.js';
import { ExportError } from './types.js';

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'opslog-export-main-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const run = async (argv: string[], env: Record<string, string> = {}) => {
  const lines: string[] = [];
  const code = await main(argv, env, (line) => lines.push(line));
  return { code, out: lines.join('\n') };
};

describe('parseArgs', () => {
  it('reads a command and --name value pairs', () => {
    const { command, flags } = parseArgs(['export', '--out', '/x', '--operator', 'op']);
    expect(command).toBe('export');
    expect(flags.get('out')).toBe('/x');
    expect(flags.get('operator')).toBe('op');
  });

  it('rejects a dangling flag, a flag without a value and positional junk', () => {
    for (const argv of [
      ['export', '--out'],
      ['export', '--out', '--operator', 'op'],
      ['export', 'x', 'y'],
    ])
      expect(() => parseArgs(argv)).toThrow(ExportError);
  });
});

describe('main', () => {
  it('prints usage and exits 2 on bad arguments', async () => {
    for (const argv of [[], ['nope'], ['export'], ['verify']]) {
      const result = await run(argv, { OPSLOG_EXPORT_KEY: randomBytes(32).toString('base64') });
      expect(result.code).toBe(2);
      expect(result.out).toContain('bad_arguments');
      expect(result.out).toContain('usage:');
    }
  });

  it('names the missing setting by code only, never by value', async () => {
    const secret = 'S3CRET-PASSWORD-VALUE-0123456789';
    const noKey = await run(['export', '--out', dir, '--operator', 'op', '--reason', 'T-1'], {
      OPSLOG_BACKUP_PASSWORD: secret,
    });
    expect(noKey.code).toBe(1);
    expect(noKey.out).toContain('missing_setting');
    expect(noKey.out).not.toContain(secret);
    const noPii = await run(['export', '--out', dir, '--operator', 'op', '--reason', 'T-1'], {
      OPSLOG_EXPORT_KEY: randomBytes(32).toString('base64'),
    });
    expect(noPii.out).toContain('missing_setting');
  });

  it('reports an unreachable database as a fixed code without the password', async () => {
    const password = 'P4SSWORD-THAT-MUST-NOT-LEAK-0123456789';
    const result = await run(['export', '--out', dir, '--operator', 'op', '--reason', 'T-1'], {
      OPSLOG_EXPORT_KEY: randomBytes(32).toString('base64'),
      OPSLOG_PII_MASTER_KEY: randomBytes(32).toString('base64'),
      OPSLOG_BACKUP_PASSWORD: password,
      OPSLOG_EXPORT_HOST: '127.0.0.1',
      OPSLOG_EXPORT_PORT: '1',
    });
    expect(result.code).toBe(1);
    expect(result.out).toContain('source_unavailable');
    expect(result.out).not.toContain(password);
  });

  it('refuses an unknown object store and a missing output folder', async () => {
    const env = {
      OPSLOG_EXPORT_KEY: randomBytes(32).toString('base64'),
      OPSLOG_PII_MASTER_KEY: randomBytes(32).toString('base64'),
      OPSLOG_BACKUP_PASSWORD: 'x'.repeat(24),
    };
    expect(
      (
        await run(
          ['export', '--out', join(dir, 'missing'), '--operator', 'op', '--reason', 'T-1'],
          env,
        )
      ).code,
    ).toBe(2);
    expect(
      (
        await run(['export', '--out', dir, '--operator', 'op', '--reason', 'T-1'], {
          ...env,
          OPSLOG_OBJECT_STORAGE: 'ftp',
        })
      ).code,
    ).toBe(2);
  });

  it('verifies and extracts an archive made by the export', async () => {
    const keyText = randomBytes(32).toString('base64');
    const result = await runExport({
      source: new FakeSource([
        table(
          'opslog_control_tenants',
          ['id', 'name', 'status', 'created_at'],
          ['id'],
          [{ id: TENANT, name: 'A', status: 'active', created_at: 'x' }],
        ),
      ]),
      cipher: new EnvelopePiiCipher(LocalDevKms.ephemeral('test')),
      objects: NO_OBJECTS,
      archiveKey: Buffer.from(keyText, 'base64'),
      outDir: dir,
      databaseName: 'opslog_t_main',
      operatorRef: 'op',
      reasonRef: 'T-1',
      logger: createLogger(() => undefined),
    });
    const ok = await run(['verify', '--archive', result.archivePath], {
      OPSLOG_EXPORT_KEY: keyText,
    });
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.out)).toMatchObject({
      msg: 'tenant_verify',
      ok: true,
      entities: 1,
      rows: 1,
    });
    const extracted = await run(
      ['extract', '--archive', result.archivePath, '--out', join(dir, 'plain')],
      { OPSLOG_EXPORT_KEY: keyText },
    );
    expect(extracted.code).toBe(0);
    const wrong = await run(['verify', '--archive', result.archivePath], {
      OPSLOG_EXPORT_KEY: randomBytes(32).toString('base64'),
    });
    expect(wrong.code).toBe(1);
    expect(wrong.out).toContain('archive_key_rejected');
  });
});
