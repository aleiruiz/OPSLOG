import type { ExclusionReason } from './catalog.js';
import type { EntryDigest, ServerInfo } from './types.js';

export const FORMAT = 'opslog-tenant-export/1';
export const MANIFEST_PATH = 'manifest.json';

export interface EntityRecord {
  readonly table: string;
  readonly rows: number;
  readonly json: EntryDigest;
  readonly csv: EntryDigest;
  /** Columns written, in order (sealed ones under their clear names). */
  readonly columns: readonly string[];
  /** Columns decrypted with the company cipher. */
  readonly decrypted: readonly string[];
  /** Columns left out on purpose (blind indexes, secrets). */
  readonly omitted: readonly string[];
}

export interface ObjectsRecord {
  readonly storage: 'memory' | 's3' | 'not_configured';
  readonly included: number;
  readonly bytes: number;
  /** Released files whose bytes the store did not have. */
  readonly missing: readonly string[];
  /** Released files whose bytes did not match the recorded SHA-256. */
  readonly corrupt: readonly string[];
  /** Files in `opslog_files` that are not released (pending upload or scan, rejected): not exported. */
  readonly notReleased: number;
  readonly entries: readonly EntryDigest[];
}

export interface Manifest {
  readonly format: typeof FORMAT;
  readonly generatedAt: string;
  readonly tool: string;
  readonly source: ServerInfo & { readonly database: string };
  readonly tenant: { readonly id: string; readonly name: string };
  readonly entities: readonly EntityRecord[];
  readonly excluded: readonly { readonly table: string; readonly reason: ExclusionReason }[];
  readonly objects: ObjectsRecord;
  /** False when a released file is missing or corrupt: the archive is a partial export. */
  readonly complete: boolean;
}

/**
 * The part of the manifest that is safe outside the sealed archive: counts, names of tables and
 * hashes. No company name and no row content. It sits next to the archive so the sealed file can
 * be checked (SHA-256) and described without the key.
 */
export function publicSummary(
  manifest: Manifest,
  archive: { readonly file: string; readonly bytes: number; readonly sha256: string },
): Record<string, unknown> {
  return {
    format: manifest.format,
    generatedAt: manifest.generatedAt,
    tool: manifest.tool,
    complete: manifest.complete,
    archive,
    source: { version: manifest.source.version, snapshotAt: manifest.source.snapshotAt },
    tenantId: manifest.tenant.id,
    entities: manifest.entities.map((e) => ({
      table: e.table,
      rows: e.rows,
      json: e.json.sha256,
      csv: e.csv.sha256,
    })),
    excluded: manifest.excluded,
    objects: {
      storage: manifest.objects.storage,
      included: manifest.objects.included,
      bytes: manifest.objects.bytes,
      missing: manifest.objects.missing.length,
      corrupt: manifest.objects.corrupt.length,
      notReleased: manifest.objects.notReleased,
    },
  };
}
