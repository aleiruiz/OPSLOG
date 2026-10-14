import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../../domain/files/src/index.js';
import { S3ObjectStorage, type S3BlobClient } from './index.js';

const ref = { tenantId: 'tenant-a', area: 'quarantine', kind: 'original', fileId: 'f1' } as const;
const bytes = new Uint8Array([1, 2, 3]);
const meta = { contentType: 'application/pdf', sha256: sha256Hex(bytes) };

/** Fake honouring If-None-Match semantics. */
function fakeClient() {
  const store = new Map<string, Uint8Array>();
  const calls: { op: string; bucket: string; key: string; kmsKeyId?: string | undefined }[] = [];
  let fail = false;
  const client: S3BlobClient = {
    async putObject(i) {
      calls.push({ op: 'put', bucket: i.bucket, key: i.key, kmsKeyId: i.kmsKeyId });
      if (fail) throw new Error('boom');
      if (store.has(i.key)) return 'exists';
      store.set(i.key, i.body);
      return 'created';
    },
    async getObject(i) {
      calls.push({ op: 'get', bucket: i.bucket, key: i.key });
      if (fail) throw new Error('boom');
      return store.get(i.key) ?? null;
    },
    async deleteObject(i) {
      calls.push({ op: 'delete', bucket: i.bucket, key: i.key });
      if (fail) throw new Error('boom');
      store.delete(i.key);
    },
  };
  return { client, store, calls, failNext: () => (fail = true) };
}

describe('S3ObjectStorage', () => {
  it('stores under the tenant-prefixed key, reads and deletes', async () => {
    const f = fakeClient();
    const storage = new S3ObjectStorage({ client: f.client, bucket: 'b' });
    await storage.putIfAbsent(ref, bytes, meta);
    expect([...f.store.keys()]).toEqual(['tenants/tenant-a/quarantine/originals/f1']);
    expect(f.calls[0]?.kmsKeyId).toBeUndefined();
    expect(await storage.get(ref)).toEqual(bytes);
    await storage.delete(ref);
    expect(await storage.get(ref)).toBeNull();
  });
  it('is a no-op for identical bytes and conflicts for different bytes', async () => {
    const f = fakeClient();
    const storage = new S3ObjectStorage({ client: f.client, bucket: 'b', kmsKeyId: 'k' });
    await storage.putIfAbsent(ref, bytes, meta);
    expect(f.calls[0]?.kmsKeyId).toBe('k');
    await storage.putIfAbsent(ref, bytes, meta);
    await expect(
      storage.putIfAbsent(ref, new Uint8Array([9]), {
        ...meta,
        sha256: sha256Hex(new Uint8Array([9])),
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
  it('conflicts when the existing object vanished or differs from the recorded bytes', async () => {
    const f = fakeClient();
    f.client.putObject = async () => 'exists';
    const storage = new S3ObjectStorage({ client: f.client, bucket: 'b' });
    await expect(storage.putIfAbsent(ref, bytes, meta)).rejects.toMatchObject({ code: 'conflict' });
  });
  it('maps client failures to storage_unavailable without leaking details', async () => {
    const f = fakeClient();
    const storage = new S3ObjectStorage({ client: f.client, bucket: 'b' });
    f.failNext();
    await expect(storage.putIfAbsent(ref, bytes, meta)).rejects.toMatchObject({
      code: 'storage_unavailable',
    });
    await expect(storage.get(ref)).rejects.toMatchObject({ code: 'storage_unavailable' });
    await expect(storage.delete(ref)).rejects.toMatchObject({ code: 'storage_unavailable' });
  });
  it('rejects invalid refs before any call and an empty bucket', async () => {
    const f = fakeClient();
    const storage = new S3ObjectStorage({ client: f.client, bucket: 'b' });
    await expect(storage.get({ ...ref, tenantId: '../x' })).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
    expect(() => new S3ObjectStorage({ client: f.client, bucket: ' ' })).toThrow();
  });
});
