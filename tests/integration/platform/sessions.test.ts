import { afterEach, describe, expect, it } from 'vitest';
import { sessionIdOf } from '../../../apps/api/composition/src/index.js';
import type { SubjectId, TenantId } from '../../../packages/domain/tenants/src/index.js';
import { corr, createWorld, jpeg, type World } from './world.js';

let world: World;
afterEach(() => world.dispose());

const HOUR = 3_600_000;
const MINUTE = 60_000;

async function fixture(w: World) {
  const a = await w.tenant('Empresa Alfa', 'subject-admin-a');
  const b = await w.tenant('Empresa Beta', 'subject-admin-b');
  const editor = await w.member(a.admin, 'editor', 'subject-editor-a');
  const file = await w.releasedFile(editor, 'alpha.jpg', jpeg('alpha'));
  const grant = await w.platform.files.createDownloadGrant(editor.token, corr(), file.id);
  return { a, b, editor, file, grant: grant.value!.grant };
}

describe('revoked, expired and changed sessions block operations and downloads', () => {
  it('blocks every operation after sign out, including a grant issued before', async () => {
    world = createWorld();
    const { platform } = world;
    const { editor, file, grant } = await fixture(world);
    expect((await platform.files.download(editor.token, corr(), grant)).ok).toBe(true);
    expect((await platform.signOut(editor.token)).ok).toBe(true);

    const attempts = [
      platform.files.upload(editor.token, corr(), {
        name: 'x.jpg',
        contentType: 'image/jpeg',
        bytes: jpeg('x'),
      }),
      platform.files.status(editor.token, corr(), file.id),
      platform.files.createDownloadGrant(editor.token, corr(), file.id),
      platform.files.download(editor.token, corr(), grant),
      platform.publish(editor.token, corr(), () => 1),
      platform.session(editor.token, corr()),
    ];
    for (const result of await Promise.all(attempts)) {
      expect(result.ok).toBe(false);
      expect(result.error).toMatchObject({ code: 'unauthorized', status: 401 });
    }
  });

  it('ends the sessions of a removed member and refuses a new login', async () => {
    world = createWorld();
    const { platform } = world;
    const { a, editor, grant } = await fixture(world);
    expect((await platform.removeMember(a.admin.token, corr(), editor.identityId)).ok).toBe(true);
    expect((await platform.session(editor.token, corr())).error?.code).toBe('unauthorized');
    expect((await platform.files.download(editor.token, corr(), grant)).error?.code).toBe(
      'unauthorized',
    );
    const again = await platform.signIn(await world.principal(editor.subject));
    expect(again.ok).toBe(false);
    // The tenant keeps working for everyone else.
    expect((await platform.session(a.admin.token, corr())).ok).toBe(true);
  });

  it('invalidates a session when the role changes and applies the new role on the next login', async () => {
    world = createWorld();
    const { platform } = world;
    const { a, editor, file } = await fixture(world);
    expect((await platform.changeRole(a.admin.token, corr(), editor.identityId, 'viewer')).ok).toBe(
      true,
    );
    // The old session (issued under the editor role) no longer works at all.
    const stale = await platform.files.upload(editor.token, corr(), {
      name: 'x.jpg',
      contentType: 'image/jpeg',
      bytes: jpeg('x'),
    });
    expect(stale.error?.code).toBe('unauthorized');
    expect((await platform.files.status(editor.token, corr(), file.id)).error?.code).toBe(
      'unauthorized',
    );
    // A fresh login holds only the new permissions: reading yes, creating no.
    const viewer = await world.signIn(editor.subject, a.tenantId);
    expect((await platform.files.status(viewer.token, corr(), file.id)).ok).toBe(true);
    const denied = await platform.files.upload(viewer.token, corr(), {
      name: 'x.jpg',
      contentType: 'image/jpeg',
      bytes: jpeg('x'),
    });
    expect(denied.error).toMatchObject({ code: 'forbidden', status: 403 });
    // Promoting again also requires a new login.
    await platform.changeRole(a.admin.token, corr(), editor.identityId, 'editor');
    expect((await platform.session(viewer.token, corr())).error?.code).toBe('unauthorized');
  });

  it('expires the session after 8 hours and a grant after its short ttl', async () => {
    world = createWorld();
    const { platform } = world;
    const { editor, file } = await fixture(world);
    const fresh = await platform.files.createDownloadGrant(editor.token, corr(), file.id);
    world.advance(6 * MINUTE);
    // Default grant ttl is 5 minutes: the grant is expired while the session is still alive.
    expect(
      (await platform.files.download(editor.token, corr(), fresh.value!.grant)).error,
    ).toMatchObject({ code: 'unauthorized', status: 401 });
    expect((await platform.session(editor.token, corr())).ok).toBe(true);
    world.advance(9 * HOUR);
    expect((await platform.session(editor.token, corr())).error?.code).toBe('unauthorized');
  });

  it('refuses sessions that were not mirrored into the control plane', async () => {
    world = createWorld();
    const { platform } = world;
    const { a, editor } = await fixture(world);
    // A session minted directly on the identity service skips signIn and has no control-plane twin.
    const rogue = await platform.identity.createSession(editor.identityId, a.tenantId);
    expect((await platform.session(rogue.token, corr())).error?.code).toBe('unauthorized');
  });
});

describe('suspended tenants', () => {
  it('rejects sessions and logins of a suspended tenant only, and recovers on reactivation', async () => {
    world = createWorld();
    const { platform } = world;
    const { a, b, editor, file } = await fixture(world);
    await platform.suspendTenant(a.tenantId);

    expect((await platform.session(a.admin.token, corr())).error?.code).toBe('unauthorized');
    expect((await platform.files.status(editor.token, corr(), file.id)).error?.code).toBe(
      'unauthorized',
    );
    const login = await platform.signIn(await world.principal(editor.subject));
    expect(login.ok).toBe(false);
    expect((await platform.session(b.admin.token, corr())).ok).toBe(true);

    await platform.reactivateTenant(a.tenantId);
    expect((await platform.session(a.admin.token, corr())).ok).toBe(true);
    const operatorTrail = world.audit.list(a.tenantId).map((event) => event.action);
    expect(operatorTrail).toEqual(
      expect.arrayContaining(['tenant.suspended', 'tenant.reactivated']),
    );
  });
});

describe('the tenant gate binds a session to its own subject', () => {
  it('refuses a session whose control-plane mirror belongs to another member of the same tenant', async () => {
    world = createWorld();
    const { platform } = world;
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    const viewer = await world.member(a.admin, 'viewer', 'subject-viewer-a');
    expect((await platform.session(viewer.token, corr())).ok).toBe(true);
    // The mirror of the viewer's session now says it belongs to the administrator: same tenant,
    // active membership at the current version, but not the person the identity session names.
    const admin = (await platform.tenants.getMembership(
      a.tenantId as TenantId,
      a.admin.identityId as SubjectId,
    ))!;
    const mirrored = (await platform.tenants.getSession(sessionIdOf(viewer.token)))!;
    await platform.tenants.saveSession({
      ...mirrored,
      subjectId: admin.subjectId,
      authorizationVersion: admin.version,
    });
    expect((await platform.session(viewer.token, corr())).error?.code).toBe('unauthorized');
    expect((await platform.listMembers(viewer.token, corr())).error?.code).toBe('unauthorized');
  });
});
