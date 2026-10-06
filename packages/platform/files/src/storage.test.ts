import { describe, expect, it } from 'vitest';
import {
  DownloadGrants,
  InMemoryObjectStorage,
  MAX_GRANT_TTL_SECONDS,
  objectKey,
  type ObjectRef,
} from './index.js';

const ref = (over: Partial<ObjectRef> = {}): ObjectRef => ({
  tenantId: 'tenant-a',
  area: 'quarantine',
  kind: 'original',
  fileId: 'file-1',
  ...over,
});
const meta = { contentType: 'image/jpeg', sha256: 'a'.repeat(64) };

describe('object keys', () => {
  it('prefix every key with the tenant and separate quarantine from released and kinds', () => {
    expect(objectKey(ref())).toBe('tenants/tenant-a/quarantine/originals/file-1');
    expect(objectKey(ref({ area: 'released', kind: 'derivative' }))).toBe(
      'tenants/tenant-a/released/derivatives/file-1',
    );
  });
  it('reject traversal, separators and unknown areas', () => {
    expect(() => objectKey(ref({ tenantId: '../tenant-b' }))).toThrow();
    expect(() => objectKey(ref({ fileId: 'a/b' }))).toThrow();
    expect(() => objectKey(ref({ area: 'public' as never }))).toThrow();
  });
});

describe('in-memory object storage fake', () => {
  it('stores copies, keeps tenants separate and deletes', async () => {
    const storage = new InMemoryObjectStorage();
    const bytes = Uint8Array.from([1, 2, 3]);
    await storage.putIfAbsent(ref(), bytes, meta);
    bytes[0] = 9;
    expect(await storage.get(ref())).toEqual(Uint8Array.from([1, 2, 3]));
    expect(await storage.get(ref({ tenantId: 'tenant-b' }))).toBeNull();
    await storage.delete(ref());
    expect(await storage.get(ref())).toBeNull();
  });
  it('is idempotent for identical content and refuses different content', async () => {
    const storage = new InMemoryObjectStorage();
    await storage.putIfAbsent(ref(), Uint8Array.from([1]), meta);
    await storage.putIfAbsent(ref(), Uint8Array.from([1]), meta);
    await expect(
      storage.putIfAbsent(ref(), Uint8Array.from([2]), { ...meta, sha256: 'b'.repeat(64) }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
  it('injects outages for put, get and delete and ignores tamper on missing keys', async () => {
    const storage = new InMemoryObjectStorage();
    storage.failNext(3);
    await expect(storage.putIfAbsent(ref(), Uint8Array.from([1]), meta)).rejects.toMatchObject({
      code: 'storage_unavailable',
    });
    await expect(storage.get(ref())).rejects.toMatchObject({ code: 'storage_unavailable' });
    await expect(storage.delete(ref())).rejects.toMatchObject({ code: 'storage_unavailable' });
    storage.tamper(ref(), Uint8Array.from([5]));
    expect(storage.keys()).toEqual([]);
  });
});

describe('download grants', () => {
  const secret = 'synthetic-grant-secret-0123456789abcdef';
  const claims = { tenantId: 'tenant-a', fileId: 'file-1', subject: 'subject-1' };
  it('round-trips claims and expires after the ttl', () => {
    let now = new Date('2026-10-06T00:00:00Z');
    const grants = new DownloadGrants(secret, () => now, 60);
    const issued = grants.issue(claims);
    expect(issued.expiresAt.toISOString()).toBe('2026-10-06T00:01:00.000Z');
    expect(grants.verify(issued.token)).toEqual(claims);
    now = new Date('2026-10-06T00:01:00Z');
    expect(() => grants.verify(issued.token)).toThrow();
  });
  it('rejects tampered payloads, foreign signatures and malformed tokens', () => {
    const grants = new DownloadGrants(secret);
    const other = new DownloadGrants('another-synthetic-secret-0123456789abcd');
    const { token } = grants.issue(claims);
    const [payload, sig] = token.split('.') as [string, string];
    const forged = Buffer.from(
      JSON.stringify({ v: 1, t: 'tenant-b', f: 'file-1', s: 'subject-1', e: Date.now() + 1e6 }),
    ).toString('base64url');
    for (const bad of [
      other.issue(claims).token,
      `${forged}.${sig}`,
      `${payload}.`,
      `${payload}`,
      `${payload}.${sig}.x`,
      `${payload}.${sig.slice(2)}`,
      '',
      undefined,
      42,
    ])
      expect(() => grants.verify(bad)).toThrow();
  });
  it('rejects signed payloads that are not valid claims', () => {
    const grants = new DownloadGrants(secret);
    const signed = (value: string): string => {
      const payload = Buffer.from(value).toString('base64url');
      return `${payload}.${(grants as unknown as { sign(p: string): Buffer }).sign(payload).toString('base64url')}`;
    };
    expect(() => grants.verify(signed('not json'))).toThrow();
    expect(() => grants.verify(signed('null'))).toThrow();
    expect(() =>
      grants.verify(signed(JSON.stringify({ v: 2, t: 'a', f: 'b', s: 'c', e: Date.now() + 1e6 }))),
    ).toThrow();
    expect(() =>
      grants.verify(signed(JSON.stringify({ v: 1, t: 'a', f: 'b', s: 'c', e: 1 }))),
    ).toThrow();
    expect(() =>
      grants.verify(signed(JSON.stringify({ v: 1, t: 1, f: 'b', s: 'c', e: Date.now() + 1e6 }))),
    ).toThrow();
  });
  it('refuses weak secrets and ttls above 15 minutes', () => {
    expect(() => new DownloadGrants('short')).toThrow();
    expect(() => new DownloadGrants(secret, () => new Date(), MAX_GRANT_TTL_SECONDS + 1)).toThrow();
    expect(() => new DownloadGrants(secret, () => new Date(), 0)).toThrow();
    expect(() => new DownloadGrants(secret, () => new Date(), MAX_GRANT_TTL_SECONDS)).not.toThrow();
  });
});
