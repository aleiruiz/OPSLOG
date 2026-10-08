import { afterEach, describe, expect, it } from 'vitest';
import { corr, createWorld, type World } from './world.js';

const HOUR = 3_600_000;
let world: World;
afterEach(() => world.dispose());

const actions = (tenantId: string) =>
  world.audit.snapshotForTesting(tenantId).map((event) => event.action);

describe('revoking a pending invitation', () => {
  it('revokes an administrator invitation: the token can no longer be inspected or accepted', async () => {
    world = createWorld();
    const { platform } = world;
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    const invited = (await platform.inviteUser(a.admin.token, corr(), 'admin')).value!;
    const listed = (await platform.listMembers(a.admin.token, corr())).value!;
    expect(listed.members.find((m) => m.id === invited.identityId)?.status).toBe('invited');

    const revoked = await platform.removeMember(a.admin.token, corr(), invited.identityId);
    expect(revoked.ok).toBe(true);
    expect(actions(a.tenantId)).toContain('invitation.revoked');
    // Revoking is a one-time operation: the pending member is gone.
    expect(
      (await platform.removeMember(a.admin.token, corr(), invited.identityId)).error?.code,
    ).toBe('not_found');

    expect((await platform.inspectInvitation(invited.invitationToken)).error?.code).toBe(
      'not_found',
    );
    const accepted = await platform.acceptInvitation(
      invited.invitationToken,
      await world.principal('subject-stray'),
    );
    expect(accepted.error?.code).toBe('unauthorized');
    // Nothing was activated: the stray subject cannot sign in and the tenant keeps its administrator.
    expect((await platform.signIn(await world.principal('subject-stray'))).ok).toBe(false);
    expect(platform.access.activeAdmins(a.tenantId)).toEqual([a.admin.identityId]);
    expect(actions(a.tenantId)).not.toContain('user.joined');
    const members = (await platform.listMembers(a.admin.token, corr())).value!.members;
    expect(members.some((m) => m.id === invited.identityId && m.status === 'invited')).toBe(false);
  });

  it('does not touch the last administrator rule and keeps other invitations valid', async () => {
    world = createWorld();
    const { platform } = world;
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    const keep = (await platform.inviteUser(a.admin.token, corr(), 'viewer')).value!;
    const drop = (await platform.inviteUser(a.admin.token, corr(), 'admin')).value!;
    expect((await platform.removeMember(a.admin.token, corr(), drop.identityId)).ok).toBe(true);
    expect(
      (await platform.acceptInvitation(keep.invitationToken, await world.principal('subject-keep')))
        .ok,
    ).toBe(true);
  });

  it('lets a new invitation be issued after the previous one was revoked', async () => {
    world = createWorld();
    const { platform } = world;
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    const first = (await platform.inviteUser(a.admin.token, corr(), 'editor')).value!;
    await platform.removeMember(a.admin.token, corr(), first.identityId);
    const second = (await platform.inviteUser(a.admin.token, corr(), 'editor')).value!;
    expect(
      (await platform.acceptInvitation(second.invitationToken, await world.principal('subject-2')))
        .ok,
    ).toBe(true);
  });

  it('answers not found for the pending invitation of another tenant and leaves it redeemable', async () => {
    world = createWorld();
    const { platform } = world;
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    const b = await world.tenant('Empresa Beta', 'subject-admin-b');
    const invitedB = (await platform.inviteUser(b.admin.token, corr(), 'admin')).value!;
    expect(
      (await platform.removeMember(a.admin.token, corr(), invitedB.identityId)).error?.code,
    ).toBe('not_found');
    expect(
      (
        await platform.acceptInvitation(
          invitedB.invitationToken,
          await world.principal('subject-invitee-b'),
        )
      ).ok,
    ).toBe(true);
  });

  it('is denied to a caller without manage_users', async () => {
    world = createWorld();
    const { platform } = world;
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    const viewer = await world.member(a.admin, 'viewer', 'subject-viewer');
    const invited = (await platform.inviteUser(a.admin.token, corr(), 'viewer')).value!;
    expect(
      (await platform.removeMember(viewer.token, corr(), invited.identityId)).error?.code,
    ).toBe('forbidden');
    expect(
      (await platform.acceptInvitation(invited.invitationToken, await world.principal('subject-x')))
        .ok,
    ).toBe(true);
  });
});

describe('invitations of a suspended tenant', () => {
  it('refuses redemption without consuming, activating or auditing, and works again after reactivation', async () => {
    world = createWorld();
    const { platform } = world;
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    const invited = (await platform.inviteUser(a.admin.token, corr(), 'editor')).value!;
    const joinedBefore = actions(a.tenantId).filter((action) => action === 'user.joined').length;

    await platform.suspendTenant(a.tenantId);
    const refused = await platform.acceptInvitation(
      invited.invitationToken,
      await world.principal('subject-late'),
    );
    expect(refused.error?.code).toBe('unauthorized');
    expect(platform.access.hasPending(invited.identityId, a.tenantId)).toBe(true);
    expect(platform.access.roleOf(a.tenantId, invited.identityId)).toBeNull();
    expect(actions(a.tenantId).filter((action) => action === 'user.joined')).toHaveLength(
      joinedBefore,
    );
    expect((await platform.signIn(await world.principal('subject-late'))).ok).toBe(false);

    // Defined behavior: the invitation survives the suspension and is redeemable until it expires.
    await platform.reactivateTenant(a.tenantId);
    const accepted = await platform.acceptInvitation(
      invited.invitationToken,
      await world.principal('subject-late'),
    );
    expect(accepted.ok).toBe(true);
    expect(platform.access.roleOf(a.tenantId, invited.identityId)).toBe('editor');
    expect(actions(a.tenantId).filter((action) => action === 'user.joined')).toHaveLength(
      joinedBefore + 1,
    );
  });

  it('keeps an invitation that expires during the suspension expired', async () => {
    world = createWorld();
    const { platform } = world;
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    const invited = (await platform.inviteUser(a.admin.token, corr(), 'viewer')).value!;
    await platform.suspendTenant(a.tenantId);
    world.advance(73 * HOUR);
    await platform.reactivateTenant(a.tenantId);
    expect(
      (await platform.acceptInvitation(invited.invitationToken, await world.principal('subject-z')))
        .error?.code,
    ).toBe('unauthorized');
  });

  it('answers unauthorized, not an internal error, for a token that is not a string', async () => {
    world = createWorld();
    const result = await world.platform.acceptInvitation(
      42 as unknown as string,
      await world.principal('subject-n'),
    );
    expect(result.error?.code).toBe('unauthorized');
  });
});
