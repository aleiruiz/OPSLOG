import { describe, expect, it } from 'vitest';
import { FilesApi } from './index.js';
import { AuthError } from '../../../../packages/domain/identity/src/index.js';
import { InMemoryFileRecordStore } from '../../../../packages/domain/files/src/index.js';
import {
  IdentityService,
  InMemoryIdentityStore,
  type IdentityAccessResolver,
  type Permission,
} from '../../../../packages/domain/identity/src/index.js';
import { InMemoryAuditStore } from '../../../../packages/platform/audit/src/index.js';
import {
  DownloadGrants,
  FakeScanner,
  FilePipeline,
  InMemoryObjectStorage,
  InMemoryScanQueue,
  SYNTHETIC_MALWARE_MARKER,
  refFor,
} from '../../../../packages/platform/files/src/index.js';

const jpeg = (tag: string): Uint8Array =>
  Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.from(tag)]);
const FULL: readonly Permission[] = ['view', 'create', 'edit', 'view_pii'];

async function world() {
  let now = new Date('2026-10-06T12:00:00Z');
  const identity = new IdentityService(new InMemoryIdentityStore(), {
    deliver: async () => undefined,
  });
  const permissions = new Map<string, readonly Permission[]>();
  const resolver: IdentityAccessResolver = {
    resolveActiveTenant: async () => null,
    resolvePermissions: async (context) => permissions.get(context.actor.subject) ?? [],
  };
  const user = async (tenantId: string, subject: string, granted: readonly Permission[] = FULL) => {
    const invitation = await identity.issueInvitation(tenantId);
    await identity.activateInvitation(invitation.token, 'oidc-test', subject);
    permissions.set(invitation.identityId, granted);
    const session = await identity.createSession(invitation.identityId, tenantId);
    return { token: session.token, identityId: invitation.identityId };
  };
  const records = new InMemoryFileRecordStore();
  const storage = new InMemoryObjectStorage();
  const scanner = new FakeScanner();
  const queue = new InMemoryScanQueue();
  const audit = new InMemoryAuditStore();
  const clock = () => now;
  let ids = 0;
  const pipeline = new FilePipeline(
    { records, storage, scanner, queue, audit },
    { now: clock, newId: () => `file-${(ids += 1)}` },
  );
  const grants = new DownloadGrants('synthetic-api-grant-secret-0123456789ab', clock, 300);
  const api = new FilesApi(identity, resolver, {
    records,
    storage,
    pipeline,
    grants,
    audit,
    now: clock,
  });
  return {
    api,
    identity,
    permissions,
    user,
    records,
    storage,
    scanner,
    pipeline,
    audit,
    grants,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}
type World = Awaited<ReturnType<typeof world>>;

async function releasedFile(w: World, token: string, tag = 'photo', sensitivity?: 'pii') {
  const uploaded = await w.api.upload(token, 'corr-up', {
    name: 'Photo.jpg',
    contentType: 'image/jpeg',
    bytes: jpeg(tag),
    ...(sensitivity ? { sensitivity } : {}),
  });
  if (!uploaded.value) throw new Error(`upload failed: ${uploaded.error?.code}`);
  await w.pipeline.processScans();
  return uploaded.value.id;
}
const grantFor = async (w: World, token: string, id: string) => {
  const result = await w.api.createDownloadGrant(token, 'corr-g', id);
  if (!result.value) throw new Error(`grant failed: ${result.error?.code}`);
  return result.value.grant;
};

describe('upload and lifecycle over the API', () => {
  it('uploads into quarantine and reports pending_scan until the scan runs', async () => {
    const w = await world();
    const { token } = await w.user('tenant-a', 'subject-a');
    const up = await w.api.upload(token, 'c1', {
      name: 'a.jpg',
      contentType: 'image/jpeg',
      bytes: jpeg('x'),
    });
    expect(up).toMatchObject({ ok: true, value: { status: 'pending_scan', kind: 'original' } });
    expect((await w.api.status(token, 'c2', 'file-1')).value?.status).toBe('pending_scan');
    await w.pipeline.processScans();
    expect((await w.api.status(token, 'c3', 'file-1')).value?.status).toBe('clean');
  });
  it('requires create for uploads and view_pii for pii uploads', async () => {
    const w = await world();
    const viewer = await w.user('tenant-a', 'viewer', ['view']);
    const creator = await w.user('tenant-a', 'creator', ['create']);
    const input = { name: 'a.jpg', contentType: 'image/jpeg', bytes: jpeg('x') };
    expect((await w.api.upload(viewer.token, 'c', input)).error?.code).toBe('forbidden');
    expect(
      (await w.api.upload(creator.token, 'c', { ...input, sensitivity: 'pii' })).error?.code,
    ).toBe('forbidden');
    expect((await w.api.upload(creator.token, 'c', input)).ok).toBe(true);
  });
  it('maps validation errors to safe 4xx payloads', async () => {
    const w = await world();
    const { token } = await w.user('tenant-a', 'subject-a');
    const spoof = await w.api.upload(token, 'c', {
      name: 'evil.jpg',
      contentType: 'image/jpeg',
      bytes: Buffer.from('MZ binary'),
    });
    expect(spoof).toEqual({
      ok: false,
      error: {
        code: 'type_mismatch',
        status: 422,
        message: 'File request rejected: type_mismatch',
      },
    });
    expect(
      (await w.api.upload('', 'c', { name: 'a', contentType: 'x', bytes: jpeg('a') })).error
        ?.status,
    ).toBe(401);
  });
  it('creates a derivative of a clean original with edit permission only', async () => {
    const w = await world();
    const editor = await w.user('tenant-a', 'editor');
    const viewer = await w.user('tenant-a', 'viewer', ['view']);
    const originalId = await releasedFile(w, editor.token);
    const input = { contentType: 'image/jpeg', bytes: jpeg('thumb'), width: 800, height: 600 };
    expect((await w.api.createDerivative(viewer.token, 'c', originalId, input)).error?.code).toBe(
      'forbidden',
    );
    const derivative = await w.api.createDerivative(editor.token, 'c', originalId, input);
    expect(derivative.value).toMatchObject({ kind: 'derivative', status: 'pending_scan' });
    expect((await w.api.createDerivative(editor.token, 'c', 'nope', input)).error?.code).toBe(
      'not_found',
    );
  });
});

describe('authorized download through the proxy', () => {
  it('serves a released file with attachment, nosniff and no-store headers', async () => {
    const w = await world();
    const { token } = await w.user('tenant-a', 'subject-a');
    const id = await releasedFile(w, token);
    const result = await w.api.download(token, 'c', await grantFor(w, token, id));
    expect(result.ok).toBe(true);
    expect(result.value?.body).toEqual(jpeg('photo'));
    expect(result.value?.headers).toMatchObject({
      'Content-Type': 'image/jpeg',
      'Content-Disposition': expect.stringMatching(/^attachment; filename="Photo\.jpg"/),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    });
  });
  it('serves a clean derivative while its original is clean', async () => {
    const w = await world();
    const { token } = await w.user('tenant-a', 'subject-a');
    const originalId = await releasedFile(w, token);
    const derivative = await w.api.createDerivative(token, 'c', originalId, {
      contentType: 'image/jpeg',
      bytes: jpeg('thumb'),
      width: 100,
      height: 100,
    });
    await w.pipeline.processScans();
    const id = derivative.value?.id ?? '';
    const result = await w.api.download(token, 'c', await grantFor(w, token, id));
    expect(result.value?.body).toEqual(jpeg('thumb'));
  });
  it('does not issue grants or serve files that are pending scan', async () => {
    const w = await world();
    const { token } = await w.user('tenant-a', 'subject-a');
    const up = await w.api.upload(token, 'c', {
      name: 'a.jpg',
      contentType: 'image/jpeg',
      bytes: jpeg('p'),
    });
    const id = up.value?.id ?? '';
    expect((await w.api.createDownloadGrant(token, 'c', id)).error).toMatchObject({
      code: 'not_available',
      status: 409,
    });
    // A grant minted outside the API for a pending file is still refused by the proxy.
    const forged = w.grants.issue({
      tenantId: 'tenant-a',
      fileId: id,
      subject: (await w.identity.authenticate(token, 'c')).actor.subject,
    });
    expect((await w.api.download(token, 'c', forged.token)).error?.code).toBe('not_available');
  });
  it('does not serve rejected files', async () => {
    const w = await world();
    const { token } = await w.user('tenant-a', 'subject-a');
    const id = await releasedFile(w, token, SYNTHETIC_MALWARE_MARKER);
    expect((await w.api.status(token, 'c', id)).value?.status).toBe('rejected');
    expect((await w.api.createDownloadGrant(token, 'c', id)).error?.code).toBe('not_available');
  });
  it('does not serve anything while the scanner is down', async () => {
    const w = await world();
    const { token } = await w.user('tenant-a', 'subject-a');
    w.scanner.down = true;
    const up = await w.api.upload(token, 'c', {
      name: 'a.jpg',
      contentType: 'image/jpeg',
      bytes: jpeg('p'),
    });
    await w.pipeline.processScans();
    expect((await w.api.createDownloadGrant(token, 'c', up.value?.id ?? '')).error?.code).toBe(
      'not_available',
    );
  });
  it('returns not_found for ids that do not exist or are malformed', async () => {
    const w = await world();
    const { token } = await w.user('tenant-a', 'subject-a');
    expect((await w.api.createDownloadGrant(token, 'c', 'file-404')).error?.code).toBe('not_found');
    expect((await w.api.createDownloadGrant(token, 'c', '../x')).error?.code).toBe('invalid_input');
    expect((await w.api.status(token, 'c', 'file-404')).error?.code).toBe('not_found');
  });
  it('refuses missing, tampered and expired grants', async () => {
    const w = await world();
    const { token } = await w.user('tenant-a', 'subject-a');
    const id = await releasedFile(w, token);
    const grant = await grantFor(w, token, id);
    expect((await w.api.download(token, 'c', 'garbage')).error?.code).toBe('unauthorized');
    expect((await w.api.download(token, 'c', `${grant}x`)).error?.code).toBe('unauthorized');
    w.advance(301_000);
    expect((await w.api.download(token, 'c', grant)).error?.code).toBe('unauthorized');
  });
  it('refuses to serve when stored bytes were altered after release', async () => {
    const w = await world();
    const { token } = await w.user('tenant-a', 'subject-a');
    const id = await releasedFile(w, token);
    const record = await w.records.get('tenant-a', id);
    w.storage.tamper(refFor(record!, 'released'), jpeg('swapped'));
    const result = await w.api.download(token, 'c', await grantFor(w, token, id));
    expect(result).toMatchObject({ ok: false, error: { code: 'integrity_failed', status: 500 } });
    expect(result.value).toBeUndefined();
  });
  it('reports not_found when the released object is missing', async () => {
    const w = await world();
    const { token } = await w.user('tenant-a', 'subject-a');
    const id = await releasedFile(w, token);
    const record = await w.records.get('tenant-a', id);
    const grant = await grantFor(w, token, id);
    await w.storage.delete(refFor(record!, 'released'));
    expect((await w.api.download(token, 'c', grant)).error?.code).toBe('not_found');
  });
  it('surfaces storage outages as 503 without bytes', async () => {
    const w = await world();
    const { token } = await w.user('tenant-a', 'subject-a');
    const id = await releasedFile(w, token);
    const grant = await grantFor(w, token, id);
    w.storage.failNext();
    expect((await w.api.download(token, 'c', grant)).error).toMatchObject({
      code: 'storage_unavailable',
      status: 503,
    });
  });
  it('hides internal error details', async () => {
    const w = await world();
    const { token } = await w.user('tenant-a', 'subject-a');
    const id = await releasedFile(w, token);
    const grant = await grantFor(w, token, id);
    w.records.get = async () => {
      throw new Error('mysql://user:secret@host exploded');
    };
    const result = await w.api.download(token, 'c', grant);
    expect(result).toEqual({
      ok: false,
      error: { code: 'internal_error', status: 500, message: 'Request failed' },
    });
  });
  it('requires view_pii to read or download pii files', async () => {
    const w = await world();
    const owner = await w.user('tenant-a', 'owner');
    const plain = await w.user('tenant-a', 'plain', ['view']);
    const id = await releasedFile(w, owner.token, 'pii-doc', 'pii');
    expect((await w.api.status(plain.token, 'c', id)).error?.code).toBe('forbidden');
    expect((await w.api.createDownloadGrant(plain.token, 'c', id)).error?.code).toBe('forbidden');
    expect((await w.api.createDownloadGrant(owner.token, 'c', id)).ok).toBe(true);
  });
});

describe('revocation', () => {
  it('blocks the proxy after the session is revoked, even with a valid grant', async () => {
    const w = await world();
    const { token } = await w.user('tenant-a', 'subject-a');
    const id = await releasedFile(w, token);
    const grant = await grantFor(w, token, id);
    expect((await w.api.download(token, 'c', grant)).ok).toBe(true);
    await w.identity.revoke(token);
    expect((await w.api.download(token, 'c', grant)).error?.code).toBe('unauthorized');
  });
  it('blocks the proxy after membership revocation', async () => {
    const w = await world();
    const { token, identityId } = await w.user('tenant-a', 'subject-a');
    const id = await releasedFile(w, token);
    const grant = await grantFor(w, token, id);
    await w.identity.revokeMembership('tenant-a', identityId);
    expect((await w.api.download(token, 'c', grant)).error?.code).toBe('unauthorized');
  });
  it('blocks the proxy when the view permission is removed after the grant was issued', async () => {
    const w = await world();
    const { token, identityId } = await w.user('tenant-a', 'subject-a');
    const id = await releasedFile(w, token);
    const grant = await grantFor(w, token, id);
    w.permissions.set(identityId, ['create']);
    expect((await w.api.download(token, 'c', grant)).error?.code).toBe('forbidden');
  });
});

describe('tenant isolation A/B', () => {
  it('treats the other tenant file as absent for status, grants and downloads', async () => {
    const w = await world();
    const a = await w.user('tenant-a', 'subject-a');
    const b = await w.user('tenant-b', 'subject-b');
    const idA = await releasedFile(w, a.token, 'tenant-a-secret');
    expect((await w.api.status(b.token, 'c', idA)).error?.code).toBe('not_found');
    expect((await w.api.createDownloadGrant(b.token, 'c', idA)).error?.code).toBe('not_found');
    expect(
      (
        await w.api.createDerivative(b.token, 'c', idA, {
          contentType: 'image/jpeg',
          bytes: jpeg('d'),
          width: 1,
          height: 1,
        })
      ).error?.code,
    ).toBe('not_found');
  });
  it('rejects a grant issued to tenant A when presented with a tenant B session', async () => {
    const w = await world();
    const a = await w.user('tenant-a', 'subject-a');
    const b = await w.user('tenant-b', 'subject-b');
    const idA = await releasedFile(w, a.token);
    const grantA = await grantFor(w, a.token, idA);
    expect((await w.api.download(b.token, 'c', grantA)).error?.code).toBe('not_found');
    // The foreign file id is not written to tenant B's audit trail.
    const denied = w.audit.list('tenant-b').filter((e) => e.action === 'file.access_denied');
    expect(denied.map((e) => e.entityId)).toEqual(['[REDACTED]']);
    expect(JSON.stringify(w.audit.list('tenant-b'))).not.toContain(idA);
  });
  it('rejects a grant presented by a different user of the same tenant', async () => {
    const w = await world();
    const a1 = await w.user('tenant-a', 'subject-1');
    const a2 = await w.user('tenant-a', 'subject-2');
    const id = await releasedFile(w, a1.token);
    expect((await w.api.download(a2.token, 'c', await grantFor(w, a1.token, id))).error?.code).toBe(
      'not_found',
    );
  });
  it('requires view and view_pii to derive from a pii original and hides other-tenant originals', async () => {
    const w = await world();
    const owner = await w.user('tenant-a', 'owner');
    const editorOnly = await w.user('tenant-a', 'editor-only', ['edit']);
    const editorView = await w.user('tenant-a', 'editor-view', ['edit', 'view']);
    const other = await w.user('tenant-b', 'other');
    const piiId = await releasedFile(w, owner.token, 'pii-original', 'pii');
    const input = { contentType: 'image/jpeg', bytes: jpeg('thumb'), width: 10, height: 10 };
    const code = async (token: string, id: string) =>
      (await w.api.createDerivative(token, 'c', id, input)).error?.code;
    expect(await code(editorOnly.token, piiId)).toBe('forbidden');
    expect(await code(editorView.token, piiId)).toBe('forbidden');
    expect(await code(other.token, piiId)).toBe('not_found');
    expect(await code(owner.token, '../x')).toBe('invalid_input');
    expect((await w.api.createDerivative(owner.token, 'c', piiId, input)).value?.status).toBe(
      'pending_scan',
    );
  });
  it('records denials only with opaque ids, never raw caller input', async () => {
    const w = await world();
    const { token } = await w.user('tenant-a', 'subject-a');
    await w.api.createDownloadGrant(token, 'c', 'a@b.example/../x');
    const events = w.audit.list('tenant-a');
    expect(events.map((e) => e.entityId)).toEqual(['[REDACTED]']);
  });
  it('keeps same local ids in both tenants separate', async () => {
    const w = await world();
    const a = await w.user('tenant-a', 'subject-a');
    const b = await w.user('tenant-b', 'subject-b');
    const up = (token: string, tag: string) =>
      w.api.upload(token, 'c', { name: 'a.jpg', contentType: 'image/jpeg', bytes: jpeg(tag) });
    // Force both tenants to the same local id by replaying the id counter.
    const first = await up(a.token, 'only-a');
    expect(first.value?.id).toBe('file-1');
    const pipelineB = new FilePipeline(
      {
        records: w.records,
        storage: w.storage,
        scanner: w.scanner,
        queue: new InMemoryScanQueue(),
        audit: w.audit,
      },
      { newId: () => 'file-1' },
    );
    const bActor = {
      tenantId: 'tenant-b',
      actorId: 'user-22222222-2222-4222-8222-222222222222',
      actorKind: 'user' as const,
      correlationId: 'c',
    };
    await pipelineB.ingestOriginal(bActor, {
      name: 'b.jpg',
      declaredType: 'image/jpeg',
      bytes: jpeg('only-b'),
    });
    await pipelineB.processScans();
    await w.pipeline.processScans();
    const grantB = await grantFor(w, b.token, 'file-1');
    expect((await w.api.download(b.token, 'c', grantB)).value?.body).toEqual(jpeg('only-b'));
    const grantA = await grantFor(w, a.token, 'file-1');
    expect((await w.api.download(a.token, 'c', grantA)).value?.body).toEqual(jpeg('only-a'));
  });
});

describe('audit trail', () => {
  it('records upload, release, grant and download without names, content or hashes', async () => {
    const w = await world();
    const { token } = await w.user('tenant-a', 'subject-a');
    const id = await releasedFile(w, token, 'confidential-body');
    await w.api.download(token, 'c', await grantFor(w, token, id));
    const events = w.audit.list('tenant-a');
    expect(events.map((e) => e.action)).toEqual([
      'file.uploaded',
      'file.released',
      'file.grant_issued',
      'file.downloaded',
    ]);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('Photo');
    expect(serialized).not.toContain('confidential-body');
    expect(serialized).not.toMatch(/[0-9a-f]{64}/);
    expect(events[0]?.actor.id).toMatch(/^user-[0-9a-f-]{36}$/);
    expect(events[1]?.actor).toEqual({ id: 'worker-files', kind: 'system' });
    expect(w.audit.list('tenant-b')).toEqual([]);
  });
  it('records a denial inside the caller tenant and nothing for unauthenticated calls', async () => {
    const w = await world();
    const a = await w.user('tenant-a', 'subject-a');
    const b = await w.user('tenant-b', 'subject-b');
    const id = await releasedFile(w, a.token);
    await w.api.createDownloadGrant(b.token, 'c', id);
    await w.api.createDownloadGrant('bad-token', 'c', id);
    expect(w.audit.list('tenant-b').map((e) => e.action)).toEqual(['file.access_denied']);
    expect(w.audit.list('tenant-a').map((e) => e.action)).not.toContain('file.access_denied');
  });
  it('does not return bytes when the download audit cannot be written', async () => {
    const w = await world();
    const { token } = await w.user('tenant-a', 'subject-a');
    const id = await releasedFile(w, token);
    const grant = await grantFor(w, token, id);
    const append = w.audit.append.bind(w.audit);
    w.audit.append = (event) => {
      if (event.action === 'file.downloaded') throw new Error('audit down');
      append(event);
    };
    const result = await w.api.download(token, 'c', grant);
    expect(result.ok).toBe(false);
    expect(result.value).toBeUndefined();
  });
  it('keeps the original denial response when the denial audit itself fails', async () => {
    const w = await world();
    const { token } = await w.user('tenant-a', 'subject-a');
    w.audit.append = () => {
      throw new Error('audit down');
    };
    expect((await w.api.createDownloadGrant(token, 'c', 'file-404')).error?.code).toBe('not_found');
  });
  it('builds an API with the default clock and a minimal resolver', async () => {
    const w = await world();
    const { token } = await w.user('tenant-a', 'subject-a');
    const api = new FilesApi(
      w.identity,
      { resolveActiveTenant: async () => null, resolvePermissions: async () => ['view'] },
      {
        records: w.records,
        storage: w.storage,
        pipeline: w.pipeline,
        grants: w.grants,
        audit: w.audit,
      },
    );
    expect((await api.status(token, 'c', 'file-404')).error?.code).toBe('not_found');
    // The denial audit uses the default clock.
    expect((await api.createDownloadGrant(token, 'c', 'file-404')).error?.code).toBe('not_found');
  });
  it('maps other authentication failures to invalid_input and expiry to a safe payload', async () => {
    const w = await world();
    const failing = (code: 'expired' | 'conflict' | 'not_found' | 'forbidden') =>
      new FilesApi(
        { authenticate: async () => Promise.reject(new AuthError(code)) } as never,
        { resolveActiveTenant: async () => null, resolvePermissions: async () => [] },
        {
          records: w.records,
          storage: w.storage,
          pipeline: w.pipeline,
          grants: w.grants,
          audit: w.audit,
        },
      );
    for (const code of ['expired', 'conflict', 'not_found'] as const) {
      const result = await failing(code).status('t', 'c', 'file-1');
      expect(result.error).toEqual({
        code: 'invalid_input',
        status: 400,
        message: 'File request rejected: invalid_input',
      });
    }
    expect((await failing('forbidden').status('t', 'c', 'file-1')).error?.code).toBe('forbidden');
  });
});
