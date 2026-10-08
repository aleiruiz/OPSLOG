import { afterEach, describe, expect, it } from 'vitest';
import { corr, createWorld, jpeg, type World } from './world.js';

let world: World;
afterEach(() => world.dispose());

async function twoTenants(w: World) {
  const a = await w.tenant('Empresa Alfa', 'subject-admin-a');
  const b = await w.tenant('Empresa Beta', 'subject-admin-b');
  const editorA = await w.member(a.admin, 'editor', 'subject-editor-a');
  const editorB = await w.member(b.admin, 'editor', 'subject-editor-b');
  return { a, b, editorA, editorB };
}

describe('a user of tenant A is denied on tenant B', () => {
  it('cannot read, grant, download or derive from B objects', async () => {
    world = createWorld();
    const { platform } = world;
    const { editorA, editorB } = await twoTenants(world);
    const fileB = await world.releasedFile(editorB, 'beta-private.jpg', jpeg('beta-bytes'));
    const grantB = await platform.files.createDownloadGrant(editorB.token, corr(), fileB.id);
    expect(grantB.ok).toBe(true);

    // Other-tenant ids look absent, never forbidden: no existence oracle.
    expect((await platform.files.status(editorA.token, corr(), fileB.id)).error).toMatchObject({
      code: 'not_found',
      status: 404,
    });
    expect(
      (await platform.files.createDownloadGrant(editorA.token, corr(), fileB.id)).error?.code,
    ).toBe('not_found');
    // B's valid grant is useless in A's session (bound to B's tenant and B's actor).
    expect(
      (await platform.files.download(editorA.token, corr(), grantB.value!.grant)).error?.code,
    ).toBe('not_found');
    expect(
      (
        await platform.files.createDerivative(editorA.token, corr(), fileB.id, {
          contentType: 'image/jpeg',
          bytes: jpeg('derived'),
          width: 100,
          height: 100,
        })
      ).error?.code,
    ).toBe('not_found');
    // The denials are audited for A with opaque ids only, and never leak into B's trail.
    const trailB = world.audit.snapshotForTesting(
      (await platform.session(editorB.token, corr())).value!.tenantId,
    );
    expect(trailB.some((event) => event.action === 'file.access_denied')).toBe(false);
  });

  it('uses each tenant own bytes when both tenants hold the same local file id', async () => {
    world = createWorld({ pipeline: { newId: () => 'shared-local-id' } });
    const { platform } = world;
    const { editorA, editorB } = await twoTenants(world);
    const a = await world.releasedFile(editorA, 'alpha.jpg', jpeg('alpha-bytes'));
    const b = await world.releasedFile(editorB, 'beta.jpg', jpeg('beta-bytes'));
    expect(a.id).toBe(b.id);
    const grantA = await platform.files.createDownloadGrant(editorA.token, corr(), a.id);
    const grantB = await platform.files.createDownloadGrant(editorB.token, corr(), b.id);
    const downloadA = await platform.files.download(editorA.token, corr(), grantA.value!.grant);
    const downloadB = await platform.files.download(editorB.token, corr(), grantB.value!.grant);
    expect(Buffer.from(downloadA.value!.body).toString('latin1')).toContain('alpha-bytes');
    expect(Buffer.from(downloadB.value!.body).toString('latin1')).toContain('beta-bytes');
    // Storage keys are tenant-prefixed and disjoint.
    const keys = world.storage.keys();
    expect(keys.length).toBeGreaterThanOrEqual(2);
    const tenantsInKeys = new Set(keys.map((key) => key.split('/')[1]));
    expect(tenantsInKeys.size).toBe(2);
  });

  it('shows each auditor only the trail of its own tenant', async () => {
    world = createWorld();
    const { platform } = world;
    const { a, b, editorB } = await twoTenants(world);
    const auditorA = await world.member(a.admin, 'auditor', 'subject-auditor-a');
    await world.releasedFile(editorB, 'beta-only.jpg');
    const trail = (await platform.listAudit(auditorA.token, corr())).value!;
    expect(trail.length).toBeGreaterThan(0);
    expect(trail.every((event) => event.tenantId === a.tenantId)).toBe(true);
    expect(trail.some((event) => event.tenantId === b.tenantId)).toBe(false);
    // A role without view_audit cannot read even its own tenant trail.
    const viewerA = await world.member(a.admin, 'viewer', 'subject-viewer-a');
    expect((await platform.listAudit(viewerA.token, corr())).error?.code).toBe('forbidden');
  });

  it('cannot administer members of another tenant by naming their ids', async () => {
    world = createWorld();
    const { platform } = world;
    const { a, b, editorB } = await twoTenants(world);
    // Identity ids of B are unknown to A: same answer as an id that does not exist.
    expect(
      (await platform.removeMember(a.admin.token, corr(), editorB.identityId)).error?.code,
    ).toBe('not_found');
    expect(
      (await platform.changeRole(a.admin.token, corr(), b.admin.identityId, 'viewer')).error?.code,
    ).toBe('not_found');
    // B is untouched: its editor still works.
    expect((await platform.session(editorB.token, corr())).ok).toBe(true);
    expect((await platform.session(b.admin.token, corr())).ok).toBe(true);
  });

  it('keeps tenant, role and invitations strictly server-side', async () => {
    world = createWorld();
    const { platform } = world;
    const { a, editorA } = await twoTenants(world);
    // An editor cannot invite, change roles or publish outside its permissions.
    expect((await platform.inviteUser(editorA.token, corr(), 'admin')).error?.code).toBe(
      'forbidden',
    );
    expect(
      (await platform.changeRole(editorA.token, corr(), a.admin.identityId, 'viewer')).error?.code,
    ).toBe('forbidden');
    expect((await platform.listAudit(editorA.token, corr())).error?.code).toBe('forbidden');
    expect(
      (await platform.publish(editorA.token, corr(), () => 1, 'manage_config')).error?.code,
    ).toBe('forbidden');
    // Unknown roles are rejected instead of silently granting something.
    expect((await platform.inviteUser(a.admin.token, corr(), 'root' as never)).error?.code).toBe(
      'invalid_input',
    );
  });
});
