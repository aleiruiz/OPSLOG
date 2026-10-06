import { afterEach, describe, expect, it } from 'vitest';
import {
  FakeScanner,
  InMemoryAuditStore,
  InMemoryObjectStorage,
  InMemoryOutboxStore,
  InMemoryTenantStore,
} from '../../../apps/api/composition/src/index.js';
import {
  IdentityEntity,
  InvitationEntity,
  MembershipEntity,
  SessionEntity,
  TypeOrmIdentityStore,
} from '../../../packages/persistence/identity/src/index.js';
import {
  FakeDatabase,
  asDataSource,
} from '../../../packages/persistence/identity/src/test-support/fake-database.js';
import { corr, createWorld, type World } from './world.js';

/**
 * The composition takes the identity store through the same `IdentityStore` port. These tests run
 * the platform on the persistent TypeORM adapter (over the in-process fake driver, so no MySQL is
 * needed here; the adapter itself is exercised against MySQL in packages/persistence/identity).
 * They prove the swap does not change observable behaviour of the existing flows.
 */
let world: World;
afterEach(() => world.dispose());

function persistentWorld() {
  const db = new FakeDatabase();
  const identityStore = new TypeOrmIdentityStore(asDataSource(db));
  world = createWorld({
    adapters: {
      identityStore,
      scanner: new FakeScanner(),
      storage: new InMemoryObjectStorage(),
      audit: new InMemoryAuditStore(),
      outbox: new InMemoryOutboxStore(() => Date.now()),
      tenants: new InMemoryTenantStore(),
    },
  });
  return { db, identityStore };
}

describe('platform on the persistent identity store', () => {
  it('runs tenant, invitation, sign-in and authenticated calls with two isolated tenants', async () => {
    const { db } = persistentWorld();
    const { platform } = world;
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    const b = await world.tenant('Empresa Beta', 'subject-admin-b');
    const editor = await world.member(a.admin, 'editor', 'subject-editor-a');
    expect((await platform.session(editor.token, corr())).value?.tenantId).toBe(a.tenantId);
    expect((await platform.session(b.admin.token, corr())).value?.tenantId).toBe(b.tenantId);
    // Rows are tenant-keyed and sessions keep only token digests.
    const memberships = db.committed(MembershipEntity);
    expect(memberships.filter((row) => row.tenantId === a.tenantId)).toHaveLength(2);
    expect(memberships.filter((row) => row.tenantId === b.tenantId)).toHaveLength(1);
    expect(JSON.stringify(db.committed(SessionEntity))).not.toContain(editor.token);
    // An administrator of A cannot manage a member of B (tenant comes from the session).
    const crossRemoval = await platform.removeMember(a.admin.token, corr(), b.admin.identityId);
    expect(crossRemoval.error?.code).toBe('not_found');
    expect((await platform.session(b.admin.token, corr())).ok).toBe(true);
  });

  it('sign out revokes the persisted session for every later call', async () => {
    const { db } = persistentWorld();
    const { platform } = world;
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    const editor = await world.member(a.admin, 'editor', 'subject-editor-a');
    expect((await platform.signOut(editor.token)).ok).toBe(true);
    expect((await platform.session(editor.token, corr())).error).toMatchObject({
      code: 'unauthorized',
      status: 401,
    });
    expect(db.committed(SessionEntity).filter((row) => row.revokedAt !== null)).toHaveLength(1);
  });

  it('removing a member bumps the persisted version, ends their sessions and refuses a new login', async () => {
    const { db, identityStore } = persistentWorld();
    const { platform } = world;
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    const editor = await world.member(a.admin, 'editor', 'subject-editor-a');
    expect((await platform.removeMember(a.admin.token, corr(), editor.identityId)).ok).toBe(true);
    expect((await platform.session(editor.token, corr())).error?.code).toBe('unauthorized');
    expect((await identityStore.findIdentity(editor.identityId))?.authorizationVersion).toBe(2);
    expect(await identityStore.findMembership(a.tenantId, editor.identityId)).toMatchObject({
      status: 'revoked',
    });
    expect((await platform.signIn(await world.principal(editor.subject))).ok).toBe(false);
    expect((await platform.session(a.admin.token, corr())).ok).toBe(true);
    expect(db.deadlocks).toBe(0);
  });

  it('keeps the last administrator rule for concurrent removals', async () => {
    const { db } = persistentWorld();
    const { platform } = world;
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    const second = await world.member(a.admin, 'admin', 'subject-admin-a2');
    const outcomes = await Promise.all([
      platform.removeMember(a.admin.token, corr(), second.identityId),
      platform.removeMember(second.token, corr(), a.admin.identityId),
    ]);
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(outcomes.find((outcome) => !outcome.ok)?.error?.code).toMatch(/last_admin|unauthorized/);
    const active = db.committed(MembershipEntity).filter((row) => row.status === 'active');
    expect(active).toHaveLength(1);
    expect(db.committed(IdentityEntity)).toHaveLength(2);
  });
  it('revokes a pending administrator invitation: the row is consumed and the token cannot be redeemed', async () => {
    const { db, identityStore } = persistentWorld();
    const { platform } = world;
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    const invited = (await platform.inviteUser(a.admin.token, corr(), 'admin')).value!;
    expect(db.committed(InvitationEntity).filter((row) => row.consumedAt === null)).toHaveLength(1);

    expect((await platform.removeMember(a.admin.token, corr(), invited.identityId)).ok).toBe(true);
    expect(db.committed(InvitationEntity).filter((row) => row.consumedAt === null)).toHaveLength(0);
    expect(await identityStore.findMembership(a.tenantId, invited.identityId)).toMatchObject({
      status: 'revoked',
    });
    const accepted = await platform.acceptInvitation(
      invited.invitationToken,
      await world.principal('subject-stray'),
    );
    expect(accepted.error?.code).toBe('unauthorized');
    expect((await platform.signIn(await world.principal('subject-stray'))).ok).toBe(false);
    expect(db.committed(MembershipEntity).filter((row) => row.status === 'active')).toHaveLength(1);
  });

  it('leaves the database untouched when a suspended tenant refuses a redemption', async () => {
    const { db, identityStore } = persistentWorld();
    const { platform } = world;
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    const invited = (await platform.inviteUser(a.admin.token, corr(), 'editor')).value!;
    const before = JSON.stringify([
      db.committed(InvitationEntity),
      db.committed(MembershipEntity),
      db.committed(IdentityEntity),
    ]);
    await platform.suspendTenant(a.tenantId);
    const refused = await platform.acceptInvitation(
      invited.invitationToken,
      await world.principal('subject-late'),
    );
    expect(refused.error?.code).toBe('unauthorized');
    expect(
      JSON.stringify([
        db.committed(InvitationEntity),
        db.committed(MembershipEntity),
        db.committed(IdentityEntity),
      ]),
    ).toBe(before);
    await platform.reactivateTenant(a.tenantId);
    expect(
      (
        await platform.acceptInvitation(
          invited.invitationToken,
          await world.principal('subject-late'),
        )
      ).ok,
    ).toBe(true);
    expect(await identityStore.findRole(a.tenantId, invited.identityId)).toBe('editor');
  });

  it('refuses permissions when the stored role no longer matches the directory', async () => {
    const { db } = persistentWorld();
    const { platform } = world;
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    const second = await world.member(a.admin, 'admin', 'subject-admin-a2');
    expect((await platform.listMembers(second.token, corr())).ok).toBe(true);
    // The role is changed in the database without touching the identity version (for example by
    // a tool or another deployment): the old session still authenticates but is not trusted.
    const row = db
      .committed(MembershipEntity)
      .find((member) => member.identityId === second.identityId)!;
    db.seed(MembershipEntity, { ...row, role: 'viewer' });
    expect((await platform.session(second.token, corr())).ok).toBe(true);
    expect((await platform.listMembers(second.token, corr())).error?.code).toBe('forbidden');
    expect((await platform.signIn(await world.principal('subject-admin-a2'))).ok).toBe(false);
    // The first administrator, whose directory and stored roles agree, is unaffected.
    expect((await platform.listMembers(a.admin.token, corr())).ok).toBe(true);
  });

  it('ends the session and refuses sign-in when another process demotes an administrator', async () => {
    const { identityStore } = persistentWorld();
    const { platform } = world;
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    const second = await world.member(a.admin, 'admin', 'subject-admin-a2');
    expect(await identityStore.setRole(a.tenantId, second.identityId, 'viewer')).toBe(true);
    expect((await platform.session(second.token, corr())).error?.code).toBe('unauthorized');
    // Signing in again must not resurrect the stale directory role.
    const again = await platform.signIn(await world.principal('subject-admin-a2'));
    expect(again.ok).toBe(false);
  });
});
