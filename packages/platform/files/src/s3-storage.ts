import { FileError, sha256Hex } from '../../../domain/files/src/index.js';
import { objectKey, type ObjectMeta, type ObjectRef, type ObjectStorage } from './storage.js';

/** Minimal S3 client the adapter needs (structurally the S3ObjectClient contract of infra/storage). */
export interface S3BlobClient {
  putObject(input: {
    bucket: string;
    key: string;
    body: Uint8Array;
    contentType: string;
    ifNoneMatch: '*';
    kmsKeyId?: string;
  }): Promise<'created' | 'exists'>;
  getObject(input: { bucket: string; key: string }): Promise<Uint8Array | null>;
  deleteObject(input: { bucket: string; key: string }): Promise<void>;
}

export interface S3ObjectStorageOptions {
  readonly client: S3BlobClient;
  readonly bucket: string;
  readonly kmsKeyId?: string;
}

/** Any client failure surfaces as `storage_unavailable`; callers never see SDK errors or key names. */
async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof FileError) throw error;
    throw new FileError('storage_unavailable');
  }
}

/** ObjectStorage backed by a private S3 bucket. Keys come only from `objectKey` (tenant-prefixed). */
export class S3ObjectStorage implements ObjectStorage {
  public constructor(private readonly options: S3ObjectStorageOptions) {
    if (!options.bucket.trim()) throw new Error('S3 bucket is required');
  }
  public async putIfAbsent(ref: ObjectRef, bytes: Uint8Array, meta: ObjectMeta): Promise<void> {
    const key = objectKey(ref);
    const { client, bucket, kmsKeyId } = this.options;
    const result = await guarded(() =>
      client.putObject({
        bucket,
        key,
        body: bytes,
        contentType: meta.contentType,
        ifNoneMatch: '*',
        ...(kmsKeyId ? { kmsKeyId } : {}),
      }),
    );
    if (result === 'created') return;
    const existing = await guarded(() => client.getObject({ bucket, key }));
    if (existing && sha256Hex(existing) === meta.sha256) return;
    throw new FileError('conflict');
  }
  public async get(ref: ObjectRef): Promise<Uint8Array | null> {
    const key = objectKey(ref);
    return guarded(() => this.options.client.getObject({ bucket: this.options.bucket, key }));
  }
  public async delete(ref: ObjectRef): Promise<void> {
    const key = objectKey(ref);
    await guarded(() => this.options.client.deleteObject({ bucket: this.options.bucket, key }));
  }
}
