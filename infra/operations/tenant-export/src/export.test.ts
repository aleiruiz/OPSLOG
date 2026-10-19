import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../../../../packages/platform/observability/src/index.js';
import { EnvelopePiiCipher, LocalDevKms } from '../../../../packages/platform/pii/src/index.js';
import { InMemoryObjectStorage } from '../../../../packages/platform/files/src/index.js';
import { AUDIT_FILE } from './audit.js';
import { runExport, type ExportRequest } from './export.js';
import { NO_OBJECTS, storageReader } from './object-reader.js';
import {
  FakeSource,
  OTHER_TENANT,
  TENANT,
  table,
  type FakeTable,
} from './test-support/fake-source.js';
import { ExportError, type FileRecord } from './types.js';
import { extractArchive, verifyArchive } from './verify.js';

const cipher = new EnvelopePiiCipher(LocalDevKms.ephemeral('test'));
const key = randomBytes(32);
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const NOW = new Date('2026-10-19T12:30:00.000Z');

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'opslog-export-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const content = new TextEncoder().encode('%PDF synthetic evidence');
const FILE: FileRecord = {
  id: 'file-1',
  kind: 'original',
  sha256: sha(content),
  sizeBytes: content.length,
};

async function data(): Promise<FakeTable[]> {
  const sealedPhone = await cipher.seal(
    { tenantId: TENANT, entityType: 'employee', entityId: 'e1', field: 'phone' },
    '555-0100',
  );
  return [
    table(
      'opslog_control_tenants',
      ['id', 'name', 'status', 'created_at'],
      ['id'],
      [
        {
          id: TENANT,
          name: 'Empresa Sintetica A',
          status: 'active',
          created_at: '2026-10-01 00:00:00.000000',
        },
      ],
    ),
    table(
      'opslog_vehicles',
      ['company_id', 'id', 'plate'],
      ['company_id', 'id'],
      [
        { company_id: TENANT, id: 'v1', plate: 'ABC-123' },
        { company_id: TENANT, id: 'v2', plate: '=cmd|x' },
        { company_id: OTHER_TENANT, id: 'v9', plate: 'ZZZ-999' },
      ],
    ),
    table(
      'opslog_employees',
      ['company_id', 'id', 'first_name', 'phone_enc', 'email_idx'],
      ['company_id', 'id'],
      [
        {
          company_id: TENANT,
          id: 'e1',
          first_name: 'Ana',
          phone_enc: sealedPhone,
          email_idx: 'f'.repeat(64),
        },
      ],
    ),
    table(
      'opslog_files',
      ['tenant_id', 'id', 'kind', 'status', 'sha256', 'size_bytes'],
      ['tenant_id', 'id'],
      [
        {
          tenant_id: TENANT,
          id: FILE.id,
          kind: 'original',
          status: 'clean',
          sha256: FILE.sha256,
          size_bytes: FILE.sizeBytes,
        },
        {
          tenant_id: TENANT,
          id: 'file-2',
          kind: 'original',
          status: 'pending_scan',
          sha256: 'c'.repeat(64),
          size_bytes: 3,
        },
      ],
    ),
    table(
      'opslog_identity_sessions',
      ['id', 'token_hash'],
      ['id'],
      [{ id: 's1', token_hash: 'SESSION-HASH' }],
    ),
    table('opslog_vehicles_migrations', ['id', 'name'], ['id'], []),
  ];
}

const lines: string[] = [];
async function request(
  overrides: Partial<ExportRequest> = {},
  tables?: FakeTable[],
): Promise<ExportRequest> {
  const storage = new InMemoryObjectStorage();
  await storage.putIfAbsent(
    { tenantId: TENANT, area: 'released', kind: 'original', fileId: FILE.id },
    content,
    {
      contentType: 'application/pdf',
      sha256: FILE.sha256,
    },
  );
  return {
    source: new FakeSource(tables ?? (await data())),
    cipher,
    objects: storageReader(storage, 'memory'),
    archiveKey: key,
    outDir: dir,
    databaseName: 'opslog_t_main',
    operatorRef: 'op-ops-1',
    reasonRef: 'TICKET-42',
    logger: createLogger(
      (line) => lines.push(line),
      {},
      () => NOW,
    ),
    now: () => NOW,
    ...overrides,
  };
}

describe('runExport', () => {
  it('writes every entity as JSON and CSV, the released files and a verifiable manifest', async () => {
    const result = await runExport(await request());
    expect(result.manifest.complete).toBe(true);
    expect(result.manifest.entities.map((e) => [e.table, e.rows])).toEqual([
      ['opslog_control_tenants', 1],
      ['opslog_employees', 1],
      ['opslog_files', 2],
      ['opslog_vehicles', 2],
    ]);
    expect(result.manifest.excluded).toEqual([
      { table: 'opslog_identity_sessions', reason: 'session_or_token' },
      { table: 'opslog_vehicles_migrations', reason: 'schema_metadata' },
    ]);
    expect(result.manifest.objects).toMatchObject({
      storage: 'memory',
      included: 1,
      notReleased: 1,
      missing: [],
      corrupt: [],
    });
    const report = await verifyArchive(result.archivePath, key);
    expect(report).toMatchObject({
      ok: true,
      problems: [],
      entities: 4,
      rows: 6,
      objects: 1,
      complete: true,
      archiveSha256: result.archiveSha256,
    });
  });

  it('puts personal data in clear only inside the sealed archive', async () => {
    const result = await runExport(await request());
    const raw = readFileSync(result.archivePath);
    for (const marker of ['555-0100', 'ABC-123', 'Empresa Sintetica A', 'file-1'])
      expect(raw.includes(marker)).toBe(false);
    const summary = readFileSync(result.summaryPath, 'utf8');
    for (const marker of ['555-0100', 'ABC-123', 'Empresa Sintetica A', 'Ana', 'SESSION-HASH'])
      expect(summary).not.toContain(marker);
    expect(JSON.parse(summary)).toMatchObject({
      complete: true,
      tenantId: TENANT,
      archive: { file: expect.stringMatching(/\.opsx$/), sha256: result.archiveSha256 },
    });
    expect(sha(readFileSync(result.archivePath))).toBe(result.archiveSha256);
  });

  it('extracts plain files: decrypted phone, no blind index, formulas kept in JSON and neutralized in CSV, other companies absent', async () => {
    const result = await runExport(await request());
    const out = join(dir, 'plain');
    await extractArchive(result.archivePath, key, out);
    const employees = JSON.parse(
      readFileSync(join(out, 'entities/opslog_employees.json'), 'utf8'),
    ) as Record<string, unknown>[];
    expect(employees).toEqual([
      { company_id: TENANT, id: 'e1', first_name: 'Ana', phone: '555-0100' },
    ]);
    const vehicles = JSON.parse(
      readFileSync(join(out, 'entities/opslog_vehicles.json'), 'utf8'),
    ) as { plate: string }[];
    expect(vehicles.map((v) => v.plate)).toEqual(['ABC-123', '=cmd|x']);
    expect(readFileSync(join(out, 'entities/opslog_vehicles.csv'), 'utf8')).toContain("v2,'=cmd|x");
    expect(readFileSync(join(out, 'entities/opslog_vehicles.json'), 'utf8')).not.toContain(
      'ZZZ-999',
    );
    expect(readFileSync(join(out, 'objects/originals/file-1'))).toEqual(Buffer.from(content));
    expect(existsSync(join(out, 'entities/opslog_identity_sessions.json'))).toBe(false);
    await expect(extractArchive(result.archivePath, key, out)).rejects.toMatchObject({
      code: 'output_exists',
    });
  });

  it('audits the execution without values and logs only event codes', async () => {
    lines.length = 0;
    const result = await runExport(await request());
    const trail = readFileSync(join(dir, AUDIT_FILE), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(trail.map((e) => e['action'])).toEqual([
      'tenant.export.started',
      'tenant.export.completed',
    ]);
    expect(trail[1]).toMatchObject({
      tenantId: TENANT,
      actor: { id: 'worker-tenant-export', kind: 'system' },
      context: {
        operatorRef: 'op-ops-1',
        reasonRef: 'TICKET-42',
        archiveSha256: result.archiveSha256,
      },
    });
    const logged = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(logged.map((e) => e['msg'])).toEqual(['tenant_export_started', 'tenant_export_done']);
    expect(lines.join('\n')).not.toContain(TENANT);
    expect(lines.join('\n')).not.toContain('555-0100');
  });

  it('reports a missing or altered released file and marks the export incomplete', async () => {
    const storage = new InMemoryObjectStorage();
    const ref = { tenantId: TENANT, area: 'released', kind: 'original', fileId: FILE.id } as const;
    await storage.putIfAbsent(ref, content, {
      contentType: 'application/pdf',
      sha256: FILE.sha256,
    });
    storage.tamper(ref, new TextEncoder().encode('tampered'));
    const corrupt = await runExport(await request({ objects: storageReader(storage, 'memory') }));
    expect(corrupt.manifest).toMatchObject({
      complete: false,
      objects: { included: 0, corrupt: [FILE.id], missing: [] },
    });
    expect((await verifyArchive(corrupt.archivePath, key)).complete).toBe(false);

    const missing = await runExport(
      await request({ objects: storageReader(new InMemoryObjectStorage(), 's3') }),
    );
    expect(missing.manifest.objects.missing).toEqual([FILE.id]);
    expect(missing.manifest.complete).toBe(false);

    const none = await runExport(await request({ objects: NO_OBJECTS }));
    expect(none.manifest).toMatchObject({
      complete: false,
      objects: { storage: 'not_configured', missing: [FILE.id] },
    });
    const trail = readFileSync(join(dir, AUDIT_FILE), 'utf8');
    expect(trail).toContain('tenant.export.incomplete');
  });

  it('stops on a table nobody classified and leaves no archive', async () => {
    const tables = [
      ...(await data()),
      table('opslog_new_module', ['company_id', 'id'], ['id'], []),
    ];
    await expect(runExport(await request({}, tables))).rejects.toMatchObject({
      code: 'unclassified_table',
    });
    expect(readdirSync(dir).filter((f) => f.endsWith('.opsx'))).toEqual([]);
    const trail = readFileSync(join(dir, AUDIT_FILE), 'utf8');
    expect(trail).toContain('tenant.export.failed');
    expect(trail).toContain('unclassified_table');
  });

  it('deletes the partial archive and audits the failure when a value cannot be opened', async () => {
    const tables = await data();
    const other = new EnvelopePiiCipher(LocalDevKms.ephemeral('test'));
    await expect(runExport(await request({ cipher: other }, tables))).rejects.toMatchObject({
      code: 'pii_open_failed',
    });
    expect(readdirSync(dir).filter((f) => f.endsWith('.opsx'))).toEqual([]);
    const trail = readFileSync(join(dir, AUDIT_FILE), 'utf8');
    expect(trail).toContain('tenant.export.failed');
    expect(trail).toContain('pii_open_failed');
  });

  it('needs the company of the database and opaque operator handles', async () => {
    const base = await request();
    await expect(
      runExport({ ...base, source: new FakeSource(await data(), null) }),
    ).rejects.toMatchObject({ code: 'tenant_unresolved' });
    await expect(runExport({ ...base, tenantId: OTHER_TENANT })).rejects.toMatchObject({
      code: 'tenant_unresolved',
    });
    // Both refusals are audited, under the id the operator asked for or a fixed placeholder.
    const failures = readFileSync(join(dir, AUDIT_FILE), 'utf8')
      .split('\n')
      .filter(
        (line) => line.includes('tenant.export.failed') && line.includes('tenant_unresolved'),
      );
    expect(failures.length).toBe(2);
    expect(failures.join('\n')).toContain('unresolved');
    await expect(runExport({ ...base, tenantId: TENANT })).resolves.toBeDefined();
    await expect(
      runExport({ ...base, operatorRef: 'Ana Perez <ana@example.test>' }),
    ).rejects.toBeInstanceOf(ExportError);
    await expect(runExport({ ...base, reasonRef: '' })).rejects.toBeInstanceOf(ExportError);
  });
});

describe('verifyArchive', () => {
  it('rejects the wrong key and flags an archive whose entry was swapped', async () => {
    const result = await runExport(await request());
    await expect(verifyArchive(result.archivePath, randomBytes(32))).rejects.toMatchObject({
      code: 'archive_key_rejected',
    });
    const damaged = readFileSync(result.archivePath);
    damaged[damaged.length - 5] = (damaged[damaged.length - 5] as number) ^ 1;
    writeFileSync(join(dir, 'damaged.opsx'), damaged);
    await expect(verifyArchive(join(dir, 'damaged.opsx'), key)).rejects.toBeInstanceOf(ExportError);
  });

  it('flags an entry that does not match the manifest', async () => {
    const { ArchiveWriter } = await import('./archive.js');
    const good = await runExport(await request());
    const writer = await ArchiveWriter.create(join(dir, 'forged.opsx'), key);
    await writer.add('entities/opslog_vehicles.json', ['[]\n']);
    await writer.add('extra/entry', ['x']);
    await writer.add('manifest.json', [JSON.stringify(good.manifest)]);
    await writer.finish();
    const report = await verifyArchive(join(dir, 'forged.opsx'), key);
    expect(report.ok).toBe(false);
    expect(report.problems).toEqual(
      expect.arrayContaining([
        'rows_differ:opslog_vehicles',
        'entry_differs:entities/opslog_vehicles.json',
        'entry_missing:entities/opslog_employees.json',
        'entry_unlisted:extra/entry',
      ]),
    );
  });

  it('reports a missing manifest', async () => {
    const { ArchiveWriter } = await import('./archive.js');
    const writer = await ArchiveWriter.create(join(dir, 'nomanifest.opsx'), key);
    await writer.add('a', ['x']);
    await writer.finish();
    expect(await verifyArchive(join(dir, 'nomanifest.opsx'), key)).toMatchObject({
      ok: false,
      problems: ['manifest_missing'],
    });
  });
});
