import { randomBytes } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PiiCipher } from '../../../../packages/platform/pii/src/index.js';
import type { Logger } from '../../../../packages/platform/observability/src/index.js';
import { opaqueRef } from '../../../../packages/platform/observability/src/index.js';
import { ArchiveWriter } from './archive.js';
import { ExportAuditTrail, requireHandles, type ExportHandles } from './audit.js';
import { dispositionOf, type ExcludedTable, type ExportedTable } from './catalog.js';
import {
  FORMAT,
  MANIFEST_PATH,
  publicSummary,
  type EntityRecord,
  type Manifest,
} from './manifest.js';
import { exportObjects } from './objects.js';
import { counted, csvChunks, jsonChunks, outputColumns, shapeRows } from './shape.js';
import {
  ExportError,
  type ExportSource,
  type FileRecord,
  type ObjectReader,
  type TableMeta,
} from './types.js';

export const TOOL = 'opslog-tenant-export/1.0';

export interface ExportRequest extends ExportHandles {
  readonly source: ExportSource;
  readonly cipher: PiiCipher;
  readonly objects: ObjectReader;
  /** The operator's key for the sealed archive. */
  readonly archiveKey: Buffer;
  /** Directory for the archive, its public summary and the audit trail; it must exist. */
  readonly outDir: string;
  readonly databaseName: string;
  readonly logger: Logger;
  /** Needed when the database holds more than one company. */
  readonly tenantId?: string | undefined;
  readonly now?: () => Date;
}

export interface ExportResult {
  readonly archivePath: string;
  readonly summaryPath: string;
  readonly manifest: Manifest;
  readonly archiveSha256: string;
}

const stamp = (date: Date): string =>
  date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');

async function resolveTenant(request: ExportRequest): Promise<{ id: string; name: string }> {
  const company = await request.source.singleCompany();
  if (request.tenantId !== undefined) {
    // An explicit id must be the company of this database: a database holds one company.
    if (!company || company.id !== request.tenantId) throw new ExportError('tenant_unresolved');
    return company;
  }
  if (!company) throw new ExportError('tenant_unresolved');
  return company;
}

/** Splits the tables into those to export and those excluded; an unclassified table stops the export. */
function classify(tables: readonly TableMeta[]) {
  const exported: { table: TableMeta; spec: ExportedTable }[] = [];
  const excluded: { table: string; reason: ExcludedTable['reason'] }[] = [];
  for (const table of tables) {
    const spec = dispositionOf(table.name);
    if (!spec) throw new ExportError('unclassified_table');
    if (spec.kind === 'export') exported.push({ table, spec });
    else excluded.push({ table: table.name, reason: spec.reason });
  }
  return { exported, excluded };
}

/**
 * Produces the company archive: JSON and CSV per entity, the released files and a manifest with the
 * SHA-256 of every entry, sealed under the operator's key. Personal data is in clear only inside that
 * sealed file. The execution is audited (see `ExportAuditTrail`) and logged without values.
 */
export async function runExport(request: ExportRequest): Promise<ExportResult> {
  const handles = requireHandles(request);
  const now = request.now ?? (() => new Date());
  const startedAt = now();
  const tenant = await resolveTenant(request);
  const audit = new ExportAuditTrail(request.outDir, tenant.id, handles, now);
  const log = request.logger.child({ companyRef: opaqueRef('c', tenant.id) });
  const base = `opslog-export-${stamp(startedAt)}-${randomBytes(3).toString('hex')}`;
  const archivePath = join(request.outDir, `${base}.opsx`);
  const summaryPath = join(request.outDir, `${base}.summary.json`);

  const info = await request.source.info();
  const { exported, excluded } = classify(await request.source.tables());
  audit.record('tenant.export.started');
  log.info('tenant_export_started', { count: exported.length });

  const writer = await ArchiveWriter.create(archivePath, request.archiveKey);
  try {
    const entities: EntityRecord[] = [];
    const released: FileRecord[] = [];
    let notReleased = 0;
    for (const { table, spec } of exported) {
      const columns = outputColumns(table, spec);
      const pass = () => {
        const tracked = counted(
          shapeRows(
            table,
            spec,
            request.source.rows(table, spec.scope, tenant.id),
            request.cipher,
            tenant.id,
          ),
        );
        return tracked;
      };
      const asJson = pass();
      const json = await writer.add(`entities/${table.name}.json`, jsonChunks(asJson.rows));
      const asCsv = pass();
      const csv = await writer.add(`entities/${table.name}.csv`, csvChunks(columns, asCsv.rows));
      const total = await request.source.count(table, spec.scope, tenant.id);
      // One snapshot: every pass sees the same rows. A difference means the snapshot was not honoured.
      if (asJson.count() !== total || asCsv.count() !== total)
        throw new ExportError('manifest_mismatch');
      entities.push({
        table: table.name,
        rows: total,
        json,
        csv,
        columns,
        decrypted: (spec.sealed ?? []).map((s) => s.as),
        omitted: spec.omit ?? [],
      });
      if (table.name === 'opslog_files') {
        for await (const row of request.source.rows(table, spec.scope, tenant.id)) {
          if (row['status'] === 'clean')
            released.push({
              id: String(row['id']),
              kind: row['kind'] === 'derivative' ? 'derivative' : 'original',
              sha256: String(row['sha256']),
              sizeBytes: Number(row['size_bytes']),
            });
          else notReleased += 1;
        }
      }
    }
    const objects = await exportObjects(writer, request.objects, tenant.id, released, notReleased);
    const manifest: Manifest = {
      format: FORMAT,
      generatedAt: now().toISOString(),
      tool: TOOL,
      source: { ...info, database: request.databaseName },
      tenant,
      entities,
      excluded,
      objects,
      complete: objects.missing.length === 0 && objects.corrupt.length === 0,
    };
    await writer.add(MANIFEST_PATH, [JSON.stringify(manifest, null, 2)]);
    const sealed = await writer.finish();
    const summary = publicSummary(manifest, {
      file: `${base}.opsx`,
      bytes: sealed.bytes,
      sha256: sealed.sha256,
    });
    writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
    audit.record(manifest.complete ? 'tenant.export.completed' : 'tenant.export.incomplete', {
      archiveSha256: sealed.sha256,
      entities: entities.length,
      objects: objects.included,
    });
    log.info('tenant_export_done', {
      count: entities.length,
      durationMs: now().getTime() - startedAt.getTime(),
    });
    return { archivePath, summaryPath, manifest, archiveSha256: sealed.sha256 };
  } catch (error) {
    writer.abort();
    rmSync(archivePath, { force: true });
    const code = error instanceof ExportError ? error.code : 'source_unavailable';
    audit.record('tenant.export.failed', { code });
    log.error('tenant_export_failed', { errorClass: 'ExportError' });
    throw error instanceof ExportError ? error : new ExportError('source_unavailable');
  }
}
