import { FileError, requireOpaqueId, type FileKind } from '../../../domain/files/src/index.js';

/** quarantine holds unscanned bytes; released holds bytes that passed the scan. */
export type StorageArea = 'quarantine' | 'released';

export interface ObjectRef {
  readonly tenantId: string;
  readonly area: StorageArea;
  readonly kind: FileKind;
  readonly fileId: string;
}

export interface ObjectMeta {
  readonly contentType: string;
  readonly sha256: string;
}

/**
 * Private object storage port (S3-style). It deliberately has no URL, presign or listing
 * operation: bytes leave only through `get`, which the API proxy calls after authorization.
 */
export interface ObjectStorage {
  /** No-op when the same bytes already exist; `conflict` when different bytes exist (no overwrite). */
  putIfAbsent(ref: ObjectRef, bytes: Uint8Array, meta: ObjectMeta): Promise<void>;
  get(ref: ObjectRef): Promise<Uint8Array | null>;
  delete(ref: ObjectRef): Promise<void>;
}

/** Tenant-prefixed key with validated opaque segments, so no id can traverse into another tenant. */
export function objectKey(ref: ObjectRef): string {
  const tenant = requireOpaqueId(ref.tenantId);
  const file = requireOpaqueId(ref.fileId);
  if (ref.area !== 'quarantine' && ref.area !== 'released') throw new FileError('invalid_input');
  const kind = ref.kind === 'derivative' ? 'derivatives' : 'originals';
  return `tenants/${tenant}/${ref.area}/${kind}/${file}`;
}

/** Synthetic in-memory fake for tests; failures can be injected to model an unavailable store. */
export class InMemoryObjectStorage implements ObjectStorage {
  private readonly objects = new Map<string, { bytes: Uint8Array; meta: ObjectMeta }>();
  private failures = 0;
  /** Makes the next `count` operations throw `storage_unavailable`. */
  public failNext(count = 1): void {
    this.failures = count;
  }
  private maybeFail(): void {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new FileError('storage_unavailable');
    }
  }
  public async putIfAbsent(ref: ObjectRef, bytes: Uint8Array, meta: ObjectMeta): Promise<void> {
    this.maybeFail();
    const key = objectKey(ref);
    const existing = this.objects.get(key);
    if (existing) {
      if (existing.meta.sha256 === meta.sha256) return;
      throw new FileError('conflict');
    }
    this.objects.set(key, { bytes: new Uint8Array(bytes), meta: { ...meta } });
  }
  public async get(ref: ObjectRef): Promise<Uint8Array | null> {
    this.maybeFail();
    const found = this.objects.get(objectKey(ref));
    return found ? new Uint8Array(found.bytes) : null;
  }
  public async delete(ref: ObjectRef): Promise<void> {
    this.maybeFail();
    this.objects.delete(objectKey(ref));
  }
  /** Test inspection only: keys currently stored. */
  public keys(): readonly string[] {
    return [...this.objects.keys()];
  }
  /** Test helper that simulates out-of-band tampering of stored bytes. */
  public tamper(ref: ObjectRef, bytes: Uint8Array): void {
    const key = objectKey(ref);
    const found = this.objects.get(key);
    if (found) this.objects.set(key, { bytes: new Uint8Array(bytes), meta: found.meta });
  }
}
