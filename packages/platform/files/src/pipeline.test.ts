import { describe, expect, it } from 'vitest';
import {
  InMemoryFileRecordStore,
  FileError,
  type FileRecord,
} from '../../../domain/files/src/index.js';
import { InMemoryAuditStore } from '../../audit/src/index.js';
import {
  FakeScanner,
  FilePipeline,
  InMemoryObjectStorage,
  InMemoryScanQueue,
  SYNTHETIC_MALWARE_MARKER,
  refFor,
  type FileActor,
} from './index.js';

const jpegBytes = (tag = 'a'): Uint8Array =>
  Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.from(tag)]);
const actorFor = (tenantId: string): FileActor => ({
  tenantId,
  actorId: 'user-11111111-1111-4111-8111-111111111111',
  actorKind: 'user',
  correlationId: 'corr-1',
});

function setup(options: ConstructorParameters<typeof FilePipeline>[1] = {}) {
  let clock = Date.parse('2026-10-06T00:00:00Z');
  let counter = 0;
  const records = new InMemoryFileRecordStore();
  const storage = new InMemoryObjectStorage();
  const scanner = new FakeScanner();
  const queue = new InMemoryScanQueue();
  const audit = new InMemoryAuditStore();
  const pipeline = new FilePipeline(
    { records, storage, scanner, queue, audit },
    { now: () => new Date(clock), newId: () => `file-${(counter += 1)}`, ...options },
  );
  return {
    records,
    storage,
    scanner,
    queue,
    audit,
    pipeline,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}
const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    return error instanceof FileError ? error.code : 'other';
  }
  return 'none';
};
const upload = (tag = 'a', name = 'Photo.jpg') => ({
  name,
  declaredType: 'image/jpeg',
  bytes: jpegBytes(tag),
});

describe('upload into quarantine', () => {
  it('stores bytes only under the quarantine prefix and records pending_scan', async () => {
    const t = setup();
    const record = await t.pipeline.ingestOriginal(actorFor('tenant-a'), upload());
    expect(record.status).toBe('pending_scan');
    expect(t.storage.keys()).toEqual(['tenants/tenant-a/quarantine/originals/file-1']);
    expect(t.queue.size()).toBe(1);
    expect(t.audit.list('tenant-a').map((e) => e.action)).toEqual(['file.uploaded']);
  });
  it('rejects spoofed content before anything is stored', async () => {
    const t = setup();
    const spoof = {
      name: 'a.jpg',
      declaredType: 'image/jpeg',
      bytes: Buffer.from('MZ-not-an-image'),
    };
    expect(await codeOf(t.pipeline.ingestOriginal(actorFor('tenant-a'), spoof))).toBe(
      'type_mismatch',
    );
    expect(t.storage.keys()).toEqual([]);
    expect(t.queue.size()).toBe(0);
  });
  it('removes the stored object when the metadata insert fails', async () => {
    const t = setup({ newId: () => 'file-dup' });
    await t.pipeline.ingestOriginal(actorFor('tenant-a'), upload('a'));
    // Same id, different bytes: the object put conflicts first, nothing is overwritten.
    expect(await codeOf(t.pipeline.ingestOriginal(actorFor('tenant-a'), upload('b')))).toBe(
      'conflict',
    );
    // Same id and same bytes: put is a no-op, insert conflicts and the compensating delete runs.
    expect(await codeOf(t.pipeline.ingestOriginal(actorFor('tenant-a'), upload('a')))).toBe(
      'conflict',
    );
    expect(t.storage.keys()).toEqual([]);
  });
  it('propagates a storage outage without creating a record', async () => {
    const t = setup();
    t.storage.failNext();
    expect(await codeOf(t.pipeline.ingestOriginal(actorFor('tenant-a'), upload()))).toBe(
      'storage_unavailable',
    );
    expect(await t.records.get('tenant-a', 'file-1')).toBeNull();
  });
});

describe('scan and release', () => {
  it('releases a clean file: released bytes first, record clean, quarantine copy removed', async () => {
    const t = setup();
    await t.pipeline.ingestOriginal(actorFor('tenant-a'), upload());
    expect(await t.pipeline.processScans()).toEqual({
      released: 1,
      rejected: 0,
      deferred: 0,
      skipped: 0,
    });
    expect((await t.records.get('tenant-a', 'file-1'))?.status).toBe('clean');
    expect(t.storage.keys()).toEqual(['tenants/tenant-a/released/originals/file-1']);
    expect(t.queue.size()).toBe(0);
    expect(t.audit.list('tenant-a').map((e) => e.action)).toEqual([
      'file.uploaded',
      'file.released',
    ]);
  });
  it('rejects a file flagged by the scanner and never creates released bytes', async () => {
    const t = setup();
    await t.pipeline.ingestOriginal(actorFor('tenant-a'), upload(SYNTHETIC_MALWARE_MARKER));
    expect((await t.pipeline.processScans()).rejected).toBe(1);
    const record = await t.records.get('tenant-a', 'file-1');
    expect([record?.status, record?.rejectionReason]).toEqual(['rejected', 'malware']);
    expect(t.storage.keys()).toEqual([]);
  });
  it('rejects a file whose quarantined bytes no longer match the recorded hash', async () => {
    const t = setup();
    const record = await t.pipeline.ingestOriginal(actorFor('tenant-a'), upload());
    t.storage.tamper(refFor(record, 'quarantine'), jpegBytes('tampered'));
    await t.pipeline.processScans();
    expect((await t.records.get('tenant-a', 'file-1'))?.rejectionReason).toBe('integrity');
    expect(t.scanner.calls).toBe(0);
  });
  it('rejects a file whose quarantined object is missing', async () => {
    const t = setup();
    const record = await t.pipeline.ingestOriginal(actorFor('tenant-a'), upload());
    await t.storage.delete(refFor(record, 'quarantine'));
    await t.pipeline.processScans();
    expect((await t.records.get('tenant-a', 'file-1'))?.rejectionReason).toBe('integrity');
  });
  it('skips and drops jobs whose record is gone or no longer pending', async () => {
    const t = setup();
    await t.queue.enqueue('tenant-a', 'ghost', 0);
    expect(await t.pipeline.processScans()).toMatchObject({ skipped: 1 });
    expect(t.queue.size()).toBe(0);
  });
  it('treats a lost status race as skipped without a second release event', async () => {
    const t = setup();
    const record = await t.pipeline.ingestOriginal(actorFor('tenant-a'), upload());
    const original = t.records.replaceIfStatus.bind(t.records);
    t.records.replaceIfStatus = async (expected, next) => {
      await original('pending_scan', { ...record, status: 'rejected' });
      return original(expected, next);
    };
    expect(await t.pipeline.processScans()).toMatchObject({ released: 0, skipped: 1 });
    expect(t.audit.list('tenant-a').map((e) => e.action)).toEqual(['file.uploaded']);
  });
  it('treats a lost race on rejection as skipped', async () => {
    const t = setup();
    const record = await t.pipeline.ingestOriginal(
      actorFor('tenant-a'),
      upload(SYNTHETIC_MALWARE_MARKER),
    );
    const original = t.records.replaceIfStatus.bind(t.records);
    t.records.replaceIfStatus = async (expected, next) => {
      await original('pending_scan', { ...record, status: 'clean' });
      return original(expected, next);
    };
    expect(await t.pipeline.processScans()).toMatchObject({ rejected: 0, skipped: 1 });
  });
  it('two concurrent runs scan a file once', async () => {
    const t = setup();
    await t.pipeline.ingestOriginal(actorFor('tenant-a'), upload());
    const [a, b] = await Promise.all([t.pipeline.processScans(), t.pipeline.processScans()]);
    expect(a.released + b.released).toBe(1);
    expect(t.scanner.calls).toBe(1);
  });
});

describe('scanner outage', () => {
  it('keeps the file in quarantine, backs off exponentially and never releases while down', async () => {
    const t = setup({ scanBackoffBaseMs: 1000, scanBackoffMaxMs: 3000 });
    await t.pipeline.ingestOriginal(actorFor('tenant-a'), upload());
    t.scanner.down = true;
    expect(await t.pipeline.processScans()).toMatchObject({ deferred: 1, released: 0 });
    // Not due yet: nothing is claimed.
    expect(await t.pipeline.processScans()).toEqual({
      released: 0,
      rejected: 0,
      deferred: 0,
      skipped: 0,
    });
    t.advance(1000);
    expect((await t.pipeline.processScans()).deferred).toBe(1);
    t.advance(1999);
    expect(t.scanner.calls).toBe(2);
    expect((await t.pipeline.processScans()).deferred).toBe(0);
    t.advance(1);
    expect((await t.pipeline.processScans()).deferred).toBe(1);
    expect((await t.records.get('tenant-a', 'file-1'))?.status).toBe('pending_scan');
    expect(t.storage.keys()).toEqual(['tenants/tenant-a/quarantine/originals/file-1']);
    expect(
      t.audit
        .list('tenant-a')
        .map((e) => e.data.attempts)
        .filter(Boolean),
    ).toEqual([1, 2, 3]);
  });
  it('releases after the scanner recovers', async () => {
    const t = setup({ scanBackoffBaseMs: 1000 });
    await t.pipeline.ingestOriginal(actorFor('tenant-a'), upload());
    t.scanner.down = true;
    await t.pipeline.processScans();
    t.scanner.down = false;
    t.advance(1000);
    expect((await t.pipeline.processScans()).released).toBe(1);
  });
  it('defers when storage fails during the scan run', async () => {
    const t = setup();
    await t.pipeline.ingestOriginal(actorFor('tenant-a'), upload());
    t.storage.failNext();
    expect((await t.pipeline.processScans()).deferred).toBe(1);
    expect((await t.records.get('tenant-a', 'file-1'))?.status).toBe('pending_scan');
  });
  it('re-claims a job whose lease expired without completion', async () => {
    const t = setup({ scanLeaseMs: 1000 });
    await t.pipeline.ingestOriginal(actorFor('tenant-a'), upload());
    const claimed = await t.queue.claimDue(Date.parse('2026-10-06T00:00:00Z'), 1000, 5);
    expect(claimed).toHaveLength(1);
    expect(await t.queue.claimDue(Date.parse('2026-10-06T00:00:00Z'), 1000, 5)).toHaveLength(0);
    expect((await t.pipeline.processScans()).released).toBe(0);
    t.advance(1000);
    expect((await t.pipeline.processScans()).released).toBe(1);
  });
  it('honours the batch limit and ignores defer/enqueue for unknown or duplicate jobs', async () => {
    const t = setup({ batchSize: 1 });
    await t.pipeline.ingestOriginal(actorFor('tenant-a'), upload('a'));
    await t.pipeline.ingestOriginal(actorFor('tenant-a'), upload('b'));
    await t.queue.enqueue('tenant-a', 'file-1', 0);
    await t.queue.defer('tenant-a', 'nope', 5);
    expect(t.queue.size()).toBe(2);
    expect((await t.pipeline.processScans()).released).toBe(1);
    expect((await t.pipeline.processScans()).released).toBe(1);
  });
});

describe('originals and derivatives', () => {
  const clean = async (t: ReturnType<typeof setup>, tenant = 'tenant-a'): Promise<FileRecord> => {
    const record = await t.pipeline.ingestOriginal(actorFor(tenant), upload());
    await t.pipeline.processScans();
    return record;
  };
  it('creates a derivative in quarantine and leaves the original bytes and record untouched', async () => {
    const t = setup();
    const original = await clean(t);
    const before = await t.storage.get(refFor(original, 'released'));
    const derivative = await t.pipeline.ingestDerivative(actorFor('tenant-a'), original.id, {
      bytes: jpegBytes('small'),
      declaredType: 'image/jpeg',
      width: 1600,
      height: 900,
    });
    expect([derivative.kind, derivative.originalId, derivative.status]).toEqual([
      'derivative',
      original.id,
      'pending_scan',
    ]);
    expect(await t.storage.get(refFor(original, 'released'))).toEqual(before);
    expect(await t.records.get('tenant-a', original.id)).toMatchObject({
      status: 'clean',
      kind: 'original',
    });
    await t.pipeline.processScans();
    expect(t.storage.keys()).toContain('tenants/tenant-a/released/derivatives/file-2');
    expect(t.audit.list('tenant-a').map((e) => e.action)).toContain('file.derivative_created');
  });
  it('refuses derivatives from pending, missing, other-tenant or derivative parents', async () => {
    const t = setup();
    const input = { bytes: jpegBytes('d'), declaredType: 'image/jpeg', width: 10, height: 10 };
    const pendingOriginal = await t.pipeline.ingestOriginal(actorFor('tenant-a'), upload('p'));
    expect(
      await codeOf(t.pipeline.ingestDerivative(actorFor('tenant-a'), pendingOriginal.id, input)),
    ).toBe('not_available');
    expect(await codeOf(t.pipeline.ingestDerivative(actorFor('tenant-a'), 'missing', input))).toBe(
      'not_found',
    );
    await t.pipeline.processScans();
    expect(
      await codeOf(t.pipeline.ingestDerivative(actorFor('tenant-b'), pendingOriginal.id, input)),
    ).toBe('not_found');
    const derivative = await t.pipeline.ingestDerivative(
      actorFor('tenant-a'),
      pendingOriginal.id,
      input,
    );
    await t.pipeline.processScans();
    expect(
      await codeOf(t.pipeline.ingestDerivative(actorFor('tenant-a'), derivative.id, input)),
    ).toBe('not_found');
  });
  it('limits derivatives to images within 2000 px', async () => {
    const t = setup();
    const original = await clean(t);
    const make = (over: object) =>
      t.pipeline.ingestDerivative(actorFor('tenant-a'), original.id, {
        bytes: jpegBytes('d'),
        declaredType: 'image/jpeg',
        width: 10,
        height: 10,
        ...over,
      });
    expect(await codeOf(make({ width: 2001 }))).toBe('invalid_input');
    expect(await codeOf(make({ declaredType: 'application/pdf' }))).toBe('unsupported_type');
  });
  it('does not allow overwriting stored original bytes with different content', async () => {
    const t = setup();
    const original = await clean(t);
    await expect(
      t.storage.putIfAbsent(refFor(original, 'released'), jpegBytes('evil'), {
        contentType: 'image/jpeg',
        sha256: 'f'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
});
