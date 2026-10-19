import type { ObjectStorage } from '../../../../packages/platform/files/src/index.js';
import type { FileRecord, ObjectReader } from './types.js';

/** Reads released files through the same object-storage port the API uses (proxy semantics, no URLs). */
export function storageReader(storage: ObjectStorage, label: 'memory' | 's3'): ObjectReader {
  return {
    label,
    async read(tenantId: string, file: FileRecord) {
      const bytes = await storage.get({
        tenantId,
        area: 'released',
        kind: file.kind,
        fileId: file.id,
      });
      return bytes ?? undefined;
    },
  };
}

/** No object store reachable from this process: files are reported as not exported. */
export const NO_OBJECTS: ObjectReader = {
  label: 'not_configured',
  async read() {
    return undefined;
  },
};
