import { createHash } from 'node:crypto';
import type { ArchiveWriter } from './archive.js';
import type { ObjectsRecord } from './manifest.js';
import type { EntryDigest, FileRecord, ObjectReader } from './types.js';

const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
/** File ids are opaque; if one is not a plain path segment it is encoded, never used as a path. */
const segment = (id: string): string =>
  SEGMENT.test(id) && id.length <= 80 ? id : `b64-${Buffer.from(id).toString('base64url')}`;

/**
 * Copies the released files (clean after the scan) into the archive and checks each against the
 * SHA-256 recorded in the database. A missing or altered object is reported in the manifest and
 * leaves the export incomplete; it is never replaced by an empty entry.
 */
export async function exportObjects(
  writer: ArchiveWriter,
  reader: ObjectReader,
  tenantId: string,
  released: readonly FileRecord[],
  notReleased: number,
): Promise<ObjectsRecord> {
  const missing: string[] = [];
  const corrupt: string[] = [];
  const entries: EntryDigest[] = [];
  let bytes = 0;
  if (reader.label !== 'not_configured') {
    for (const file of released) {
      const content = await reader.read(tenantId, file);
      if (!content) {
        missing.push(file.id);
        continue;
      }
      if (createHash('sha256').update(content).digest('hex') !== file.sha256) {
        corrupt.push(file.id);
        continue;
      }
      const folder = file.kind === 'derivative' ? 'derivatives' : 'originals';
      const entry = await writer.add(`objects/${folder}/${segment(file.id)}`, [content]);
      entries.push(entry);
      bytes += entry.bytes;
    }
  } else missing.push(...released.map((f) => f.id));
  return {
    storage: reader.label,
    included: entries.length,
    bytes,
    missing,
    corrupt,
    notReleased,
    entries,
  };
}
