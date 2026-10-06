import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { corr, createWorld, jpeg, type World } from './world.js';

const USER_ACTOR = /^user-[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/;
const SYSTEM_ACTOR = /^(system|worker-[a-z0-9_-]+)$/;

let world: World;
afterEach(() => world.dispose());

describe('tenant -> user -> object -> audit with tenants A and B', () => {
  it('runs the full flow in each tenant and keeps the trails separate', async () => {
    world = createWorld();
    const { platform } = world;
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    const b = await world.tenant('Empresa Beta', 'subject-admin-b');
    expect(a.tenantId).not.toBe(b.tenantId);

    // Tenant context comes from the session; both tenants are active with a verified location.
    const contextA = await platform.session(a.admin.token, corr());
    expect(contextA.value?.tenantId).toBe(a.tenantId);
    expect(Object.isFrozen(contextA.value)).toBe(true);

    const editorA = await world.member(a.admin, 'editor', 'subject-editor-a');
    const auditorA = await world.member(a.admin, 'auditor', 'subject-auditor-a');
    const editorB = await world.member(b.admin, 'editor', 'subject-editor-b');
    const auditorB = await world.member(b.admin, 'auditor', 'subject-auditor-b');

    const name = 'licencia-juan-perez.jpg';
    const bytesA = jpeg('alpha-object');
    const uploadA = await platform.files.upload(editorA.token, corr(), {
      name,
      contentType: 'image/jpeg',
      bytes: bytesA,
    });
    expect(uploadA.value?.status).toBe('pending_scan');
    const fileA = uploadA.value!.id;

    // Pending files are not downloadable yet.
    const early = await platform.files.createDownloadGrant(editorA.token, corr(), fileA);
    expect(early.error?.code).toBe('not_available');

    const scans = await platform.runtime.runScans();
    expect(scans).toMatchObject({ released: 1, rejected: 0, deferred: 0 });
    expect((await platform.files.status(editorA.token, corr(), fileA)).value?.status).toBe('clean');

    const grant = await platform.files.createDownloadGrant(editorA.token, corr(), fileA);
    const download = await platform.files.download(editorA.token, corr(), grant.value!.grant);
    expect(download.ok).toBe(true);
    expect(Buffer.from(download.value!.body)).toEqual(Buffer.from(bytesA));
    expect(download.value!.headers['Content-Disposition']).toMatch(/^attachment/);

    // The same flow in B produces B-only records.
    const fileB = await world.releasedFile(editorB, 'beta-object.jpg');

    const trailA = (await platform.listAudit(auditorA.token, corr())).value!;
    const trailB = (await platform.listAudit(auditorB.token, corr())).value!;
    expect(trailA.every((event) => event.tenantId === a.tenantId)).toBe(true);
    expect(trailB.every((event) => event.tenantId === b.tenantId)).toBe(true);
    const actionsA = trailA.map((event) => event.action);
    expect(actionsA).toEqual(
      expect.arrayContaining([
        'tenant.bootstrapped',
        'user.invited',
        'user.joined',
        'file.uploaded',
        'file.released',
        'file.grant_issued',
        'file.downloaded',
      ]),
    );
    expect(trailA.some((event) => event.entityId === fileB.id)).toBe(false);
    expect(trailB.some((event) => event.entityId === fileA)).toBe(false);
    expect(trailB.some((event) => event.action === 'file.downloaded')).toBe(false);

    // Who did what: user actions carry the opaque user ref, system work carries a worker ref.
    const downloaded = trailA.find((event) => event.action === 'file.downloaded');
    expect(downloaded?.actor.id).toBe(`user-${editorA.identityId}`);
    expect(trailA.find((event) => event.action === 'file.released')?.actor.id).toBe('worker-files');
  });

  it('keeps PII, secrets and content out of the audit trail', async () => {
    world = createWorld();
    const { platform } = world;
    const a = await world.tenant('Empresa Alfa', 'subject-pii-admin');
    const editor = await world.member(a.admin, 'editor', 'subject-pii-editor');
    const auditor = await world.member(a.admin, 'auditor', 'subject-pii-auditor');
    const name = 'licencia-maria-lopez.jpg';
    const bytes = jpeg('contenido-sensible');
    const upload = await platform.files.upload(editor.token, corr(), {
      name,
      contentType: 'image/jpeg',
      bytes,
    });
    await platform.runtime.runScans();
    const grant = await platform.files.createDownloadGrant(editor.token, corr(), upload.value!.id);
    await platform.files.download(editor.token, corr(), grant.value!.grant);
    await platform.files.status(editor.token, corr(), 'does-not-exist');
    platform.runtime.worker.register('demo.created', () => undefined);
    await platform.publish(editor.token, corr(), (emit) =>
      emit({
        type: 'demo.created',
        entityId: upload.value!.id,
        payload: { email: 'maria.lopez@example.test', phone: '+52 55 1234 5678' },
      }),
    );
    await platform.runtime.drainOutbox();

    const trail = (await platform.listAudit(auditor.token, corr())).value!;
    const text = JSON.stringify(trail);
    const forbidden = [
      name,
      'maria',
      'lopez',
      'example.test',
      '1234 5678',
      'subject-pii',
      editor.token,
      auditor.token,
      grant.value!.grant,
      createHash('sha256').update(bytes).digest('hex'),
      'contenido-sensible',
      'Empresa Alfa',
    ];
    for (const value of forbidden) expect(text).not.toContain(value);
    for (const event of trail) {
      expect(Object.keys(event.data).every((key) => key === 'attempts')).toBe(true);
      expect(USER_ACTOR.test(event.actor.id) || SYSTEM_ACTOR.test(event.actor.id)).toBe(true);
    }
  });

  it('publishes an outbox event for the session tenant and audits its delivery', async () => {
    world = createWorld();
    const { platform } = world;
    const a = await world.tenant('Empresa Alfa', 'subject-outbox-a');
    const b = await world.tenant('Empresa Beta', 'subject-outbox-b');
    const seen: string[] = [];
    platform.runtime.worker.register('object.created', (_payload, event) => {
      seen.push(event.tenantId);
    });
    await platform.publish(a.admin.token, corr(), (emit) =>
      emit({ type: 'object.created', entityId: 'obj-a', payload: { n: 1 } }),
    );
    await platform.publish(b.admin.token, corr(), (emit) =>
      emit({ type: 'object.created', entityId: 'obj-b', payload: { n: 2 } }),
    );
    expect(await platform.runtime.drainOutbox()).toBe(2);
    expect([...seen].sort()).toEqual([a.tenantId, b.tenantId].sort());
    const records = world.outbox.all();
    expect(records.every((record) => record.status === 'delivered')).toBe(true);
    const auditA = (await platform.listAudit(a.admin.token, corr())).value!;
    expect(auditA.filter((event) => event.action === 'outbox.delivered')).toHaveLength(1);
    expect(auditA.find((event) => event.action === 'outbox.delivered')?.tenantId).toBe(a.tenantId);
  });
});
