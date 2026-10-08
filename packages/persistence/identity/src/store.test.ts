import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AuthError,
  opaqueTokenGenerator,
  type ExternalIdentity,
  type Identity,
  type IdentityStore,
  type Invitation,
  type Membership,
  type RecoveryRequest,
  type Session,
  type IdentityMutationAudit,
} from '../../../domain/identity/src/index.js';
import {
  IDENTITY_TABLES,
  ExternalIdentityEntity,
  IdentityEntity,
  InvitationEntity,
  MembershipEntity,
  RecoveryEntity,
  SessionEntity,
  RoleEntity,
  RolePermissionEntity,
  TenantLockEntity,
} from './entities.js';
import { IdentityStoreError, LastAdministratorError } from './errors.js';
import {
  ADMIN_ROLE,
  CUSTOM_ROLE_LIMITS,
  DEFAULT_ROLE,
  TypeOrmIdentityStore,
  isRoleName,
  type StoreErrorEvent,
} from './store.js';
import {
  DEADLOCK,
  FakeDatabase,
  LOCK_TIMEOUT,
  asDataSource,
} from './test-support/fake-database.js';
import { Clock, HOUR, PROVIDER, T0, createHarness, setup } from './test-support/harness.js';

const tenantA = 'tenant-a';
const tenantB = 'tenant-b';
const hashOf = (token: string) => opaqueTokenGenerator.hash(token);

const rejection = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
};

describe('construction guards', () => {
  const store = (options: Record<string, unknown>) =>
    new TypeOrmIdentityStore({ options } as never);
  it('requires MySQL, no synchronize and a restricted runtime account', () => {
    expect(() => store({ type: 'postgres', username: 'opslog_identity_x' })).toThrow(/MySQL/);
    expect(() =>
      store({ type: 'mysql', username: 'opslog_identity_x', synchronize: true }),
    ).toThrow(/synchronize/);
    expect(() => store({ type: 'mysql', username: 'root' })).toThrow(/restricted runtime account/);
    expect(() => store({ type: 'mysql' })).toThrow(/restricted runtime account/);
    expect(() => store({ type: 'mysql', username: 'opslog_identity_runtime' })).not.toThrow();
    expect(() => store({ type: 'mysql', username: 'opslog_control_runtime' })).not.toThrow();
  });
  it('treats a non-positive attempt budget as a single attempt', async () => {
    const { db, store: s, join } = setup({ maxAttempts: 0 });
    const { identityId } = await join(tenantA, 'sub-1', 'viewer');
    await join(tenantA, 'sub-2', ADMIN_ROLE);
    db.failNext('findOne', DEADLOCK, { entity: TenantLockEntity });
    await expect(s.revokeMembership(tenantA, identityId)).rejects.toMatchObject({
      code: 'contention',
    });
  });
  it('validates role names', () => {
    expect(['admin', 'pii_reader', 'a'].map(isRoleName)).toEqual([true, true, true]);
    expect(['Admin', '', '1x', 'a-b', 'x'.repeat(33), 5].map(isRoleName)).toEqual(
      Array(6).fill(false),
    );
  });
});

describe('transactional audit mutation ports', () => {
  it('commits audit with invitation activation, membership revocation and role creation', async () => {
    const db = new FakeDatabase();
    const store = new TypeOrmIdentityStore(asDataSource(db), {
      appendAudit: async () => undefined,
    });
    const harness = createHarness(store, new Clock());
    const tenantId = 'tenant-audit';
    const makeAudit = (action: string, entityId: string): IdentityMutationAudit => ({
      eventId: randomUUID(),
      tenantId,
      action,
      entityType: 'membership',
      entityId,
      occurredAt: T0.toISOString(),
      actor: { id: 'user-admin', kind: 'user' },
      correlationId: randomUUID(),
      data: {},
    });
    await harness.join(tenantId, 'audit-admin', ADMIN_ROLE);
    const pending = await harness.invite(tenantId, 'viewer');
    expect(
      await store.activateInvitationWithAudit(
        pending.tokenHash,
        PROVIDER,
        'audit-viewer',
        T0,
        makeAudit('user.joined', pending.identityId),
      ),
    ).not.toBeNull();
    const member = await harness.join(tenantId, 'audit-revoked', 'editor');
    expect(
      await store.revokeMembershipWithAudit(
        tenantId,
        member.identityId,
        makeAudit('membership.revoked', member.identityId),
      ),
    ).toBe(true);
    expect(
      await store.createCustomRoleWithAudit(
        tenantId,
        { id: 'custom-audit-role', name: 'Audit role', permissions: [] },
        50,
        makeAudit('role.copied', 'custom-audit-role'),
      ),
    ).toBe('created');
  });
});

describe('identity service flows over the persistent store (72 h invitations, 8 h sessions)', () => {
  it('runs bootstrap, invitation, session, authentication and logout', async () => {
    const { service, store, clock, db } = setup();
    const admin = await service.provisionExternal(PROVIDER, 'admin-subject');
    expect(admin).toMatchObject({ status: 'active', authorizationVersion: 1 });
    expect(await service.provisionExternal(PROVIDER, 'admin-subject')).toEqual(admin);
    const resolved = await service.resolveExternal(PROVIDER, 'admin-subject');
    expect(resolved.id).toBe(admin.id);

    const invitation = await service.issueInvitation(tenantA);
    expect(invitation.expiresAt.getTime() - clock.current.getTime()).toBe(72 * HOUR);
    expect(await store.findInvitationTenant(hashOf(invitation.token), clock.now())).toBe(tenantA);
    const activation = await service.activateInvitation(invitation.token, PROVIDER, 'new-subject');
    expect(await store.findInvitationTenant(hashOf(invitation.token), clock.now())).toBeNull();
    expect(activation.membership).toMatchObject({ status: 'active', tenantId: tenantA });
    expect(activation.identity.status).toBe('active');
    // The membership created through the plain port has the least-privilege role.
    expect(await store.findRole(tenantA, activation.identity.id)).toBe(DEFAULT_ROLE);

    const session = await service.createSession(activation.identity.id, tenantA);
    expect(session.expiresAt.getTime() - clock.current.getTime()).toBe(8 * HOUR);
    const context = await service.authenticate(session.token, 'corr-1');
    expect(context).toMatchObject({ tenantId: tenantA, authorizationVersion: 1 });
    expect(context.actor.subject).toBe(activation.identity.id);

    await service.revoke(session.token);
    await expect(service.authenticate(session.token, 'corr-2')).rejects.toMatchObject({
      code: 'unauthorized',
    });
    // Only the digest of the opaque token is stored.
    const stored = db.committed(SessionEntity);
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain(session.token);
    expect(stored[0]?.tokenHash).toBe(hashOf(session.token));
  });

  it('expires sessions after 8 hours and invitations after 72 hours', async () => {
    const { service, clock, join, login, invite, store } = setup();
    const member = await join(tenantA, 'sub-1', 'viewer');
    const session = await login(member.identityId, tenantA);
    clock.advance(8 * HOUR - 1);
    await expect(service.authenticate(session.token, 'c')).resolves.toBeDefined();
    clock.advance(1);
    await expect(service.authenticate(session.token, 'c')).rejects.toMatchObject({
      code: 'unauthorized',
    });

    const pending = await invite(tenantA, 'viewer');
    clock.advance(72 * HOUR - 1);
    expect(
      await store.activateInvitation(pending.tokenHash, PROVIDER, 'late', clock.now()),
    ).not.toBeNull();
    const second = await invite(tenantA, 'viewer');
    clock.advance(72 * HOUR);
    expect(await store.activateInvitation(second.tokenHash, PROVIDER, 'later', clock.now())).toBe(
      null,
    );
  });

  it('single-use invitation: a second activation of the same token fails', async () => {
    const { store, invite, clock } = setup();
    const invited = await invite(tenantA, 'viewer');
    expect(
      await store.activateInvitation(invited.tokenHash, PROVIDER, 'one', clock.now()),
    ).not.toBe(null);
    expect(await store.activateInvitation(invited.tokenHash, PROVIDER, 'one', clock.now())).toBe(
      null,
    );
    expect(await store.activateInvitation(invited.tokenHash, PROVIDER, 'two', clock.now())).toBe(
      null,
    );
  });

  it('recovery invalidates every session of the identity', async () => {
    const { service, join, login, deliveries } = setup();
    const member = await join(tenantA, 'sub-1', 'viewer');
    const session = await login(member.identityId, tenantA);
    await service.requestRecovery(member.identityId);
    await service.settled();
    const delivery = deliveries[0];
    if (!delivery) throw new Error('recovery was not delivered');
    const refreshed = await service.consumeRecovery(delivery.token);
    expect(refreshed.authorizationVersion).toBe(2);
    await expect(service.authenticate(session.token, 'c')).rejects.toMatchObject({
      code: 'unauthorized',
    });
    await expect(service.consumeRecovery(delivery.token)).rejects.toBeInstanceOf(AuthError);
  });
});

describe('createExternalIdentity', () => {
  const identity = (id = randomUUID()): Identity => ({
    id,
    status: 'active',
    mfa: 'disabled',
    authorizationVersion: 1,
    createdAt: T0,
  });
  const link = (identityId: string, subject: string, provider = PROVIDER): ExternalIdentity => ({
    id: randomUUID(),
    provider,
    subject,
    identityId,
    status: 'active',
    createdAt: T0,
  });

  it('returns the winner when one subject is created concurrently, leaving no orphan identity', async () => {
    const { store, db } = setup();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => {
        const candidate = identity();
        return store.createExternalIdentity(candidate, link(candidate.id, 'racing-subject'));
      }),
    );
    expect(new Set(results.map((item) => item.id)).size).toBe(1);
    expect(db.committed(ExternalIdentityEntity)).toHaveLength(1);
    expect(db.committed(IdentityEntity)).toHaveLength(1);
    expect(db.deadlocks).toBe(0);
  });

  it('keys are case and padding sensitive', async () => {
    const { store, db } = setup();
    for (const subject of ['Abc', 'abc', 'abc ']) {
      const candidate = identity();
      await store.createExternalIdentity(candidate, link(candidate.id, subject));
    }
    expect(db.committed(ExternalIdentityEntity)).toHaveLength(3);
    const other = identity();
    const winner = await store.createExternalIdentity(other, link(other.id, 'abc', 'other-idp'));
    expect(winner.provider).toBe('other-idp');
    expect((await store.findExternal(PROVIDER, 'Abc'))?.subject).toBe('Abc');
    expect(await store.findExternal(PROVIDER, 'ABC')).toBeNull();
  });

  it('conflicts when the identity id is reused for another subject', async () => {
    const { store } = setup();
    const candidate = identity();
    await store.createExternalIdentity(candidate, link(candidate.id, 'one'));
    await expect(
      store.createExternalIdentity(candidate, link(candidate.id, 'two')),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('rejects malformed input before touching the database', async () => {
    const { store, db } = setup();
    const candidate = identity();
    const good = link(candidate.id, 'subject');
    const bad: [Identity, ExternalIdentity][] = [
      [candidate, { ...good, identityId: 'someone-else' }],
      [candidate, { ...good, subject: '   ' }],
      [candidate, { ...good, subject: 'x'.repeat(201) }],
      [candidate, { ...good, provider: '' }],
      [candidate, { ...good, id: '' }],
      [
        { ...candidate, id: 'x'.repeat(65) },
        { ...good, identityId: 'x'.repeat(65) },
      ],
      [{ ...candidate, createdAt: new Date(Number.NaN) }, good],
      [candidate, { ...good, createdAt: new Date(Number.NaN) }],
    ];
    for (const [i, e] of bad)
      await expect(store.createExternalIdentity(i, e)).rejects.toMatchObject({
        code: 'invalid_input',
      });
    expect(db.transactions).toBe(0);
  });
});

describe('invitations', () => {
  it('creates pending identity, membership and invitation atomically and supersedes older links', async () => {
    const { store, db, invite, clock } = setup();
    const first = await invite(tenantA, 'viewer');
    expect(db.committed(MembershipEntity)).toMatchObject([{ status: 'pending', role: 'viewer' }]);
    clock.advance(HOUR);
    const second = await invite(tenantA, 'editor', first.identityId);
    const rows = db.committed(InvitationEntity);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === first.invitation.id)?.consumedAt).toEqual(clock.now());
    expect(db.committed(MembershipEntity)).toHaveLength(1);
    // The reissue re-targets the pending membership to the new role without replacing it.
    expect(db.committed(MembershipEntity)[0]).toMatchObject({ role: 'editor', status: 'pending' });
    expect(await store.activateInvitation(first.tokenHash, PROVIDER, 's', clock.now())).toBeNull();
    expect(
      await store.activateInvitation(second.tokenHash, PROVIDER, 's', clock.now()),
    ).not.toBeNull();
  });

  it('keeps the role of a pending membership when a plain port invitation is reissued', async () => {
    const { db, store, invite, clock } = setup();
    const first = await invite(tenantA, ADMIN_ROLE);
    const identity = (await store.findIdentity(first.identityId)) as Identity;
    const token = opaqueTokenGenerator.create();
    await store.createInvitation(
      identity,
      { ...first.membership, id: randomUUID() },
      {
        id: randomUUID(),
        tenantId: tenantA,
        identityId: identity.id,
        tokenHash: hashOf(token),
        expiresAt: new Date(clock.now().getTime() + HOUR),
        consumedAt: null,
      },
    );
    expect(db.committed(MembershipEntity)[0]).toMatchObject({ role: ADMIN_ROLE });
    // Same role requested again: no membership write.
    const before = db.statements.length;
    await invite(tenantA, ADMIN_ROLE, first.identityId);
    expect(
      db.statements.slice(before).filter((s) => s === 'update opslog_identity_memberships'),
    ).toHaveLength(0);
  });

  it('refuses revoked identities and active memberships, and reissues revoked memberships', async () => {
    const { store, db, join, invite } = setup();
    const admin = await join(tenantA, 'admin', ADMIN_ROLE);
    const member = await join(tenantA, 'member', 'viewer');
    await expect(invite(tenantA, 'viewer', member.identityId)).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(await store.revokeMembership(tenantA, member.identityId)).toBe(true);
    const again = await invite(tenantA, 'editor', member.identityId);
    expect(await store.findMembership(tenantA, member.identityId)).toMatchObject({
      status: 'pending',
      id: again.membership.id,
      activatedAt: null,
    });
    expect(await store.findRole(tenantA, member.identityId)).toBeNull();
    // A revoked identity cannot be invited at all.
    db.seed(IdentityEntity, {
      ...(db.committed(IdentityEntity).find((row) => row.id === admin.identityId) ?? {}),
      status: 'revoked',
    });
    await expect(invite(tenantA, 'viewer', admin.identityId)).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('validates its input and the optional role', async () => {
    const { store, db, invite } = setup();
    const base = await invite(tenantA, 'viewer');
    const identity = (await store.findIdentity(base.identityId)) as Identity;
    const good = { membership: base.membership, invitation: base.invitation };
    const variants: [Membership, Invitation][] = [
      [{ ...good.membership, identityId: 'x' }, good.invitation],
      [good.membership, { ...good.invitation, identityId: 'x' }],
      [good.membership, { ...good.invitation, tenantId: tenantB }],
      [good.membership, { ...good.invitation, tokenHash: 'not-a-sha256' }],
      [good.membership, { ...good.invitation, expiresAt: new Date(Number.NaN) }],
      [{ ...good.membership, id: '' }, good.invitation],
      [good.membership, { ...good.invitation, id: '' }],
      [
        { ...good.membership, tenantId: ' ' },
        { ...good.invitation, tenantId: ' ' },
      ],
      [{ ...good.membership, createdAt: new Date(Number.NaN) }, good.invitation],
    ];
    const before = db.transactions;
    for (const [membership, invitation] of variants)
      await expect(store.createInvitation(identity, membership, invitation)).rejects.toMatchObject({
        code: 'invalid_input',
      });
    await expect(
      store.createInvitation(identity, good.membership, good.invitation, new Date(Number.NaN)),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      store.createInvitation(
        { ...identity, createdAt: new Date(Number.NaN) },
        good.membership,
        good.invitation,
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      store.createInvitationWithRole(identity, good.membership, good.invitation, 'Not A Role'),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(db.transactions).toBe(before);
  });
});

describe('activateInvitation', () => {
  it('serializes concurrent activations: exactly one succeeds for one token', async () => {
    const { store, invite, clock, db } = setup();
    const invited = await invite(tenantA, 'viewer');
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        store.activateInvitation(invited.tokenHash, PROVIDER, 'same-subject', clock.now()),
      ),
    );
    expect(results.filter((item) => item !== null)).toHaveLength(1);
    expect(db.deadlocks).toBe(0);
    expect(db.committed(ExternalIdentityEntity)).toHaveLength(1);
  });

  it('binds only one subject when different subjects race for one pending identity', async () => {
    const { store, invite, clock, db } = setup();
    const invited = await invite(tenantA, 'viewer');
    const results = await Promise.all(
      ['alice', 'mallory', 'trudy'].map((subject) =>
        store.activateInvitation(invited.tokenHash, PROVIDER, subject, clock.now()),
      ),
    );
    expect(results.filter((item) => item !== null)).toHaveLength(1);
    expect(db.committed(ExternalIdentityEntity)).toHaveLength(1);
  });

  it('rejects takeover attempts: other subject on a linked identity, subject of another identity', async () => {
    const { store, join, invite, clock } = setup();
    const owner = await join(tenantA, 'owner', 'viewer');
    // A second tenant invites the same (already linked) identity: a different subject must fail.
    const reinvite = await invite(tenantB, 'viewer', owner.identityId);
    expect(
      await store.activateInvitation(reinvite.tokenHash, PROVIDER, 'attacker', clock.now()),
    ).toBeNull();
    // A subject that already belongs to another identity cannot be bound to this one.
    const other = await invite(tenantB, 'viewer');
    expect(
      await store.activateInvitation(other.tokenHash, PROVIDER, 'owner', clock.now()),
    ).toBeNull();
    // The legitimate subject can join the second tenant with the same identity.
    const ok = await store.activateInvitation(reinvite.tokenHash, PROVIDER, 'owner', clock.now());
    expect(ok?.identity.id).toBe(owner.identityId);
    expect(ok?.membership.tenantId).toBe(tenantB);
  });

  it('rejects an active identity without a link and unknown, malformed or revoked inputs', async () => {
    const { store, db, invite, clock } = setup();
    const invited = await invite(tenantA, 'viewer');
    db.seed(IdentityEntity, {
      ...(db.committed(IdentityEntity)[0] ?? {}),
      status: 'active',
    });
    expect(
      await store.activateInvitation(invited.tokenHash, PROVIDER, 'subject', clock.now()),
    ).toBeNull();
    expect(await store.activateInvitation('nope', PROVIDER, 's', clock.now())).toBeNull();
    expect(await store.activateInvitation(invited.tokenHash, '', 's', clock.now())).toBeNull();
    expect(
      await store.activateInvitation(invited.tokenHash, PROVIDER, ' ', clock.now()),
    ).toBeNull();
    expect(
      await store.activateInvitation(invited.tokenHash, PROVIDER, 's', new Date(Number.NaN)),
    ).toBeNull();
    expect(await store.activateInvitation('0'.repeat(64), PROVIDER, 's', clock.now())).toBeNull();
    db.seed(IdentityEntity, { ...(db.committed(IdentityEntity)[0] ?? {}), status: 'revoked' });
    expect(
      await store.activateInvitation(invited.tokenHash, PROVIDER, 'subject', clock.now()),
    ).toBeNull();
  });

  it('rejects when the membership is no longer pending', async () => {
    const { store, invite, clock } = setup();
    const invited = await invite(tenantA, 'viewer');
    expect(await store.revokeMembership(tenantA, invited.identityId)).toBe(true);
    expect(
      await store.activateInvitation(invited.tokenHash, PROVIDER, 'subject', clock.now()),
    ).toBeNull();
  });

  it('revoking a pending membership consumes its invitation and cannot be undone by a replay', async () => {
    const { store, db, invite, clock } = setup();
    const invited = await invite(tenantA, ADMIN_ROLE);
    const other = await invite(tenantA, 'viewer');
    expect(await store.revokeMembership(tenantA, invited.identityId)).toBe(true);
    const rows = db.committed(InvitationEntity);
    expect(rows.find((row) => row.id === invited.invitation.id)?.consumedAt).toEqual(clock.now());
    // Only that membership's invitation is consumed.
    expect(rows.find((row) => row.id === other.invitation.id)?.consumedAt).toBeNull();
    expect(await store.revokeMembership(tenantA, invited.identityId)).toBe(false);
    expect(
      await store.activateInvitation(invited.tokenHash, PROVIDER, 'subject', clock.now()),
    ).toBeNull();
    expect(await store.findMembership(tenantA, invited.identityId)).toMatchObject({
      status: 'revoked',
    });
  });

  it('rolls everything back when the external link loses a unique-key race', async () => {
    const { store, db, invite, clock } = setup();
    const invited = await invite(tenantA, 'viewer');
    db.failNext(
      'insert',
      { errno: 1062, code: 'ER_DUP_ENTRY' },
      { entity: ExternalIdentityEntity },
    );
    expect(
      await store.activateInvitation(invited.tokenHash, PROVIDER, 'subject', clock.now()),
    ).toBeNull();
    expect(db.committed(IdentityEntity)[0]?.status).toBe('pending');
    expect(db.committed(InvitationEntity)[0]?.consumedAt).toBeNull();
    // A non-duplicate failure on that insert is an infrastructure error, not a silent null.
    db.failNext(
      'insert',
      { errno: 2013, code: 'PROTOCOL_CONNECTION_LOST' },
      { entity: ExternalIdentityEntity },
    );
    await expect(
      store.activateInvitation(invited.tokenHash, PROVIDER, 'subject', clock.now()),
    ).rejects.toBeInstanceOf(IdentityStoreError);
  });

  it('refuses to commit when the invitation was consumed behind its back', async () => {
    const { store, db, invite, clock } = setup();
    const invited = await invite(tenantA, 'viewer');
    let injected = false;
    db.intercept = (operation, table) => {
      if (injected || operation !== 'update' || table !== 'opslog_identity_invitations') return;
      injected = true;
      const row = db.committed(InvitationEntity)[0] ?? {};
      db.seed(InvitationEntity, { ...row, consumedAt: clock.now() });
    };
    expect(
      await store.activateInvitation(invited.tokenHash, PROVIDER, 'subject', clock.now()),
    ).toBeNull();
    expect(db.committed(IdentityEntity)[0]?.status).toBe('pending');
    expect(db.committed(ExternalIdentityEntity)).toHaveLength(0);
  });
});

describe('roles and the last administrator', () => {
  it('refuses to revoke the only active administrator, and counts only active admins', async () => {
    const { store, join, invite } = setup();
    const admin = await join(tenantA, 'admin', ADMIN_ROLE);
    await invite(tenantA, ADMIN_ROLE); // a pending admin does not count
    const error = await rejection(store.revokeMembership(tenantA, admin.identityId));
    expect(error).toBeInstanceOf(LastAdministratorError);
    expect(error).toBeInstanceOf(AuthError);
    expect(error).toMatchObject({ code: 'conflict', reason: 'last_admin' });
    expect(await store.countActiveAdmins(tenantA)).toBe(1);
    expect(await store.findMembership(tenantA, admin.identityId)).toMatchObject({
      status: 'active',
    });
    // Nothing was bumped or revoked by the refused attempt.
    expect((await store.findIdentity(admin.identityId))?.authorizationVersion).toBe(1);
  });

  it('allows removing an admin when another remains and a non-admin at any time', async () => {
    const { store, join } = setup();
    const first = await join(tenantA, 'admin-1', ADMIN_ROLE);
    const second = await join(tenantA, 'admin-2', ADMIN_ROLE);
    const viewer = await join(tenantA, 'viewer', 'viewer');
    expect(await store.revokeMembership(tenantA, viewer.identityId)).toBe(true);
    expect(await store.revokeMembership(tenantA, first.identityId)).toBe(true);
    await expect(store.revokeMembership(tenantA, second.identityId)).rejects.toBeInstanceOf(
      LastAdministratorError,
    );
    expect(await store.countActiveAdmins(tenantA)).toBe(1);
  });

  it('two concurrent removals of the last two administrators cannot remove both', async () => {
    for (let round = 0; round < 25; round += 1) {
      const { store, join, db } = setup();
      const a = await join(tenantA, `admin-a-${round}`, ADMIN_ROLE);
      const b = await join(tenantA, `admin-b-${round}`, ADMIN_ROLE);
      const outcomes = await Promise.allSettled([
        store.revokeMembership(tenantA, a.identityId),
        store.revokeMembership(tenantA, b.identityId),
      ]);
      expect(outcomes.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
      const failed = outcomes.find((item) => item.status === 'rejected');
      expect((failed as PromiseRejectedResult).reason).toBeInstanceOf(LastAdministratorError);
      expect(await store.countActiveAdmins(tenantA)).toBe(1);
      expect(db.deadlocks).toBe(0);
    }
  });

  it('removals and demotions of three administrators leave at least one, in any interleaving', async () => {
    const { store, join, db } = setup();
    const ids = [] as string[];
    for (let i = 0; i < 3; i += 1)
      ids.push((await join(tenantA, `admin-${i}`, ADMIN_ROLE)).identityId);
    const [x, y, z] = ids as [string, string, string];
    const outcomes = await Promise.allSettled([
      store.revokeMembership(tenantA, x),
      store.setRole(tenantA, y, 'viewer'),
      store.revokeMembership(tenantA, z),
    ]);
    expect(outcomes.filter((item) => item.status === 'fulfilled')).toHaveLength(2);
    expect(await store.countActiveAdmins(tenantA)).toBe(1);
    expect(db.deadlocks).toBe(0);
  });

  it('a removal and a demotion of the two admins cannot both succeed', async () => {
    for (let round = 0; round < 10; round += 1) {
      const { store, join } = setup();
      const a = await join(tenantA, `a-${round}`, ADMIN_ROLE);
      const b = await join(tenantA, `b-${round}`, ADMIN_ROLE);
      const outcomes = await Promise.allSettled([
        store.setRole(tenantA, a.identityId, 'editor'),
        store.revokeMembership(tenantA, b.identityId),
      ]);
      expect(outcomes.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
      expect(await store.countActiveAdmins(tenantA)).toBe(1);
    }
  });

  it('serializes admin changes per tenant only: another tenant is never blocked by this lock', async () => {
    const { store, join, db } = setup();
    const a1 = await join(tenantA, 'a1', ADMIN_ROLE);
    await join(tenantA, 'a2', ADMIN_ROLE);
    const b1 = await join(tenantB, 'b1', ADMIN_ROLE);
    await join(tenantB, 'b2', ADMIN_ROLE);
    await store.revokeMembership(tenantA, a1.identityId); // creates tenant A's lock row
    const holder = db.transaction('READ COMMITTED', async (manager) => {
      await manager
        .getRepository(TenantLockEntity)
        .findOne({ where: { tenantId: tenantA }, lock: { mode: 'pessimistic_write' } });
      // While tenant A's lock row is held open, tenant B still makes progress.
      expect(await store.revokeMembership(tenantB, b1.identityId)).toBe(true);
    });
    await holder;
    expect(db.deadlocks).toBe(0);
  });

  it('setRole validates, ignores revoked or unknown memberships and bumps only active role changes', async () => {
    const { store, join, invite } = setup();
    const admin = await join(tenantA, 'admin', ADMIN_ROLE);
    const viewer = await join(tenantA, 'viewer', 'viewer');
    await expect(store.setRole(tenantA, viewer.identityId, 'BAD')).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(store.setRole('', viewer.identityId, 'editor')).rejects.toMatchObject({
      code: 'invalid_input',
    });
    expect(await store.setRole(tenantA, randomUUID(), 'editor')).toBe(false);
    expect(await store.setRole(tenantB, viewer.identityId, 'editor')).toBe(false);
    // Same role: success without bumping.
    expect(await store.setRole(tenantA, viewer.identityId, 'viewer')).toBe(true);
    expect((await store.findIdentity(viewer.identityId))?.authorizationVersion).toBe(1);
    // Active role change bumps the version.
    expect(await store.setRole(tenantA, viewer.identityId, 'editor')).toBe(true);
    expect(await store.findRole(tenantA, viewer.identityId)).toBe('editor');
    expect((await store.findIdentity(viewer.identityId))?.authorizationVersion).toBe(2);
    // Promotion to admin is fine; demotion of the last admin is not.
    expect(await store.setRole(tenantA, viewer.identityId, ADMIN_ROLE)).toBe(true);
    expect(await store.setRole(tenantA, admin.identityId, 'viewer')).toBe(true);
    await expect(store.setRole(tenantA, viewer.identityId, 'viewer')).rejects.toBeInstanceOf(
      LastAdministratorError,
    );
    // A pending membership changes role without a bump; a revoked one is not editable.
    const pending = await invite(tenantA, 'viewer');
    expect(await store.setRole(tenantA, pending.identityId, 'editor')).toBe(true);
    expect((await store.findIdentity(pending.identityId))?.authorizationVersion).toBe(1);
    expect(await store.revokeMembership(tenantA, admin.identityId)).toBe(true);
    expect(await store.setRole(tenantA, admin.identityId, 'editor')).toBe(false);
  });

  it('read helpers tolerate malformed arguments', async () => {
    const { store } = setup();
    expect(await store.findRole('', 'x')).toBeNull();
    expect(await store.findMembership('x', '')).toBeNull();
    expect(await store.countActiveAdmins(' ')).toBe(0);
    expect(await store.findIdentity('x'.repeat(65))).toBeNull();
    expect(await store.findExternal('', 'x')).toBeNull();
  });

  it('fails closed when the tenant lock row disappears under the transaction', async () => {
    const { store, join, db, events } = setup();
    const a = await join(tenantA, 'a', ADMIN_ROLE);
    await join(tenantA, 'b', ADMIN_ROLE);
    db.intercept = (operation, table) => {
      if (operation === 'findOne' && table === 'opslog_identity_tenant_locks')
        db.clear(TenantLockEntity);
    };
    await expect(store.revokeMembership(tenantA, a.identityId)).rejects.toMatchObject({
      code: 'integrity',
    });
    expect(events.at(-1)).toMatchObject({ operation: 'revokeMembership', code: 'integrity' });
    expect(await store.countActiveAdmins(tenantA)).toBe(2);
  });
});

describe('revocation and version bumps', () => {
  it('a removed member loses every session: sessions are revoked and the version is bumped', async () => {
    const { store, service, join, login, db } = setup();
    await join(tenantA, 'admin', ADMIN_ROLE);
    const member = await join(tenantA, 'member', 'viewer');
    const first = await login(member.identityId, tenantA);
    const second = await login(member.identityId, tenantA);
    expect(await service.authenticate(first.token, 'c')).toBeDefined();
    expect(await store.revokeMembership(tenantA, member.identityId)).toBe(true);
    for (const session of [first, second])
      await expect(service.authenticate(session.token, 'c')).rejects.toMatchObject({
        code: 'unauthorized',
      });
    expect(db.committed(SessionEntity).every((row) => row.revokedAt instanceof Date)).toBe(true);
    expect((await store.findIdentity(member.identityId))?.authorizationVersion).toBe(2);
    expect(await store.findMembership(tenantA, member.identityId)).toMatchObject({
      status: 'revoked',
    });
    expect(await store.revokeMembership(tenantA, member.identityId)).toBe(false);
  });

  it('is a no-op for unknown tenants or identities and creates no lock rows for them', async () => {
    const { store, db } = setup();
    expect(await store.revokeMembership('ghost-tenant', 'ghost')).toBe(false);
    expect(await store.revokeMembership('', 'x')).toBe(false);
    expect(db.committed(TenantLockEntity)).toHaveLength(0);
    expect(db.transactions).toBe(0);
  });

  it('revokes a pending membership too', async () => {
    const { store, invite } = setup();
    const invited = await invite(tenantA, 'viewer');
    expect(await store.revokeMembership(tenantA, invited.identityId)).toBe(true);
  });

  it('returns false when the membership or identity vanishes between the pre-check and the lock', async () => {
    const { store, join, db } = setup();
    const member = await join(tenantA, 'member', 'viewer');
    db.intercept = (operation, table) => {
      if (operation === 'findOne' && table === 'opslog_identity_memberships') {
        db.intercept = null;
        db.clear(MembershipEntity);
      }
    };
    expect(await store.revokeMembership(tenantA, member.identityId)).toBe(false);
    const other = await join(tenantA, 'other', 'viewer');
    db.intercept = (operation, table) => {
      if (operation === 'findOne' && table === 'opslog_identity_tenant_locks') {
        db.intercept = null;
        db.clear(IdentityEntity);
      }
    };
    expect(await store.revokeMembership(tenantA, other.identityId)).toBe(false);
    db.intercept = null;
    const third = await join(tenantA, 'third', 'viewer');
    db.intercept = (operation, table) => {
      if (operation === 'findOne' && table === 'opslog_identity_identities') {
        db.intercept = null;
        const row = db.committed(MembershipEntity).find((m) => m.identityId === third.identityId);
        db.seed(MembershipEntity, { ...(row ?? {}), status: 'revoked' });
      }
    };
    expect(await store.revokeMembership(tenantA, third.identityId)).toBe(false);
  });

  it('setRole returns false when the rows vanish under the lock', async () => {
    const { store, join, db } = setup();
    const member = await join(tenantA, 'member', 'viewer');
    db.intercept = (operation, table) => {
      if (operation === 'findOne' && table === 'opslog_identity_tenant_locks') {
        db.intercept = null;
        db.clear(IdentityEntity);
      }
    };
    expect(await store.setRole(tenantA, member.identityId, 'editor')).toBe(false);
    const other = await join(tenantA, 'other', 'viewer');
    db.intercept = (operation, table) => {
      if (operation === 'findOne' && table === 'opslog_identity_identities') {
        db.intercept = null;
        const row = db.committed(MembershipEntity).find((m) => m.identityId === other.identityId);
        db.seed(MembershipEntity, { ...(row ?? {}), status: 'revoked' });
      }
    };
    expect(await store.setRole(tenantA, other.identityId, 'editor')).toBe(false);
  });
});

describe('sessions', () => {
  const session = (identityId: string, tenantId: string, token: string): Session => ({
    id: randomUUID(),
    identityId,
    tenantId,
    tokenHash: hashOf(token),
    createdAt: T0,
    lastSeenAt: T0,
    expiresAt: new Date(T0.getTime() + 8 * HOUR),
    revokedAt: null,
    authorizationVersion: 1,
  });

  it('stores, finds and revokes sessions once', async () => {
    const { store, join, clock } = setup();
    const member = await join(tenantA, 'member', 'viewer');
    const value = session(member.identityId, tenantA, 'token-1');
    await store.saveSession(value);
    expect(await store.findSession(value.tokenHash)).toEqual(value);
    expect(await store.findSession(hashOf('unknown'))).toBeNull();
    expect(await store.findSession('short')).toBeNull();
    expect(await store.revokeSession(value.id, clock.now())).toBe(true);
    expect(await store.revokeSession(value.id, clock.now())).toBe(false);
    expect((await store.findSession(value.tokenHash))?.revokedAt).toEqual(clock.now());
    expect(await store.revokeSession('', clock.now())).toBe(false);
    expect(await store.revokeSession(value.id, new Date(Number.NaN))).toBe(false);
  });

  it('a revoked session never authenticates, even if the version still matches', async () => {
    const { service, join, login } = setup();
    const member = await join(tenantA, 'member', 'viewer');
    const issued = await login(member.identityId, tenantA);
    await expect(service.authenticate(issued.token, 'c')).resolves.toMatchObject({
      tenantId: tenantA,
    });
    await service.revoke(issued.token);
    await expect(service.authenticate(issued.token, 'c')).rejects.toMatchObject({
      code: 'unauthorized',
    });
  });

  it('requires a membership of the session tenant and a unique token', async () => {
    const { store, join, db } = setup();
    const member = await join(tenantA, 'member', 'viewer');
    await expect(
      store.saveSession(session(member.identityId, tenantB, 'token-b')),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(
      store.saveSession(session('ghost-identity', tenantA, 'token-g')),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    // The DML-only runtime account sees the missing parent as ER_NO_REFERENCED_ROW (1216).
    db.missingParentError = { errno: 1216, code: 'ER_NO_REFERENCED_ROW' };
    await expect(
      store.saveSession(session(member.identityId, tenantB, 'token-c')),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    db.missingParentError = { errno: 1452, code: 'ER_NO_REFERENCED_ROW_2' };
    await store.saveSession(session(member.identityId, tenantA, 'token-dup'));
    await expect(
      store.saveSession(session(member.identityId, tenantA, 'token-dup')),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('validates session input', async () => {
    const { store, join } = setup();
    const member = await join(tenantA, 'member', 'viewer');
    const good = session(member.identityId, tenantA, 'token-v');
    const bad: Session[] = [
      { ...good, id: '' },
      { ...good, identityId: '' },
      { ...good, tenantId: '' },
      { ...good, tokenHash: 'xyz' },
      { ...good, createdAt: new Date(Number.NaN) },
      { ...good, lastSeenAt: new Date(Number.NaN) },
      { ...good, expiresAt: new Date(Number.NaN) },
      { ...good, authorizationVersion: 0 },
      { ...good, authorizationVersion: 1.5 },
    ];
    for (const value of bad)
      await expect(store.saveSession(value)).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('tenant isolation', () => {
  it('memberships, roles and revocations never cross tenants', async () => {
    const { store, join, login, service, db } = setup();
    const adminA = await join(tenantA, 'admin-a', ADMIN_ROLE);
    await join(tenantA, 'admin-a2', ADMIN_ROLE);
    const adminB = await join(tenantB, 'admin-b', ADMIN_ROLE);
    await join(tenantB, 'admin-b2', ADMIN_ROLE);
    const shared = await join(tenantA, 'shared', 'viewer');
    const sharedInB = await join(tenantB, 'shared', 'editor', shared.identityId);
    expect(sharedInB.identityId).toBe(shared.identityId);

    // Tenant-scoped keys: same identity, two independent memberships and roles.
    expect(await store.findRole(tenantA, shared.identityId)).toBe('viewer');
    expect(await store.findRole(tenantB, shared.identityId)).toBe('editor');
    expect(await store.findMembership(tenantA, adminB.identityId)).toBeNull();
    expect(await store.findMembership(tenantB, adminA.identityId)).toBeNull();
    expect(await store.findRole(tenantA, adminB.identityId)).toBeNull();

    // Naming tenant A with an identity that only belongs to B changes nothing in B.
    expect(await store.revokeMembership(tenantA, adminB.identityId)).toBe(false);
    expect(await store.setRole(tenantA, adminB.identityId, 'viewer')).toBe(false);
    expect(await store.findRole(tenantB, adminB.identityId)).toBe(ADMIN_ROLE);
    expect(await store.countActiveAdmins(tenantB)).toBe(2);

    // A session is bound to its tenant and cannot be opened against another one.
    const sessionA = await login(adminA.identityId, tenantA);
    expect((await service.authenticate(sessionA.token, 'c')).tenantId).toBe(tenantA);
    await expect(login(adminA.identityId, tenantB)).rejects.toMatchObject({
      code: 'unauthorized',
    });
    expect(db.committed(SessionEntity).map((row) => row.tenantId)).toEqual([tenantA]);

    // Removing the shared member from A leaves their membership in B active.
    expect(await store.revokeMembership(tenantA, shared.identityId)).toBe(true);
    expect(await store.findMembership(tenantB, shared.identityId)).toMatchObject({
      status: 'active',
    });
    expect(await store.findRole(tenantB, shared.identityId)).toBe('editor');
  });

  it('an invitation token only ever activates the membership of its own tenant', async () => {
    const { store, invite, clock } = setup();
    const invitedA = await invite(tenantA, 'viewer');
    const invitedB = await invite(tenantB, ADMIN_ROLE);
    const activation = await store.activateInvitation(
      invitedA.tokenHash,
      PROVIDER,
      'subject-a',
      clock.now(),
    );
    expect(activation?.membership.tenantId).toBe(tenantA);
    expect(await store.findMembership(tenantB, invitedA.identityId)).toBeNull();
    expect(await store.findMembership(tenantB, invitedB.identityId)).toMatchObject({
      status: 'pending',
    });
  });
});

describe('recovery requests', () => {
  const request = (identityId: string, token: string, issuedAt = T0): RecoveryRequest => ({
    id: randomUUID(),
    identityId,
    tokenHash: hashOf(token),
    issuedAt,
    expiresAt: new Date(issuedAt.getTime() + HOUR),
    usedAt: null,
  });

  it('supersedes older unused requests and finds them by token hash', async () => {
    const { store, join, db } = setup();
    const member = await join(tenantA, 'member', 'viewer');
    const first = request(member.identityId, 'r1');
    const second = request(member.identityId, 'r2', new Date(T0.getTime() + 1000));
    await store.saveRecovery(first);
    await store.saveRecovery(second);
    expect((await store.findRecovery(first.tokenHash))?.supersededAt).toEqual(second.issuedAt);
    expect((await store.findRecovery(second.tokenHash))?.supersededAt).toBeNull();
    expect(await store.findRecovery(hashOf('unknown'))).toBeNull();
    expect(await store.findRecovery('bad')).toBeNull();
    expect(await store.consumeRecovery(first.id, T0)).toBe(false);
    expect(db.committed(RecoveryEntity)).toHaveLength(2);
  });

  it('consumes once under concurrency and bumps the version exactly once', async () => {
    const { store, join, db } = setup();
    const member = await join(tenantA, 'member', 'viewer');
    const value = request(member.identityId, 'r1');
    await store.saveRecovery(value);
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () => store.consumeRecovery(value.id, new Date(T0.getTime() + 1))),
    );
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect((await store.findIdentity(member.identityId))?.authorizationVersion).toBe(2);
    expect(db.deadlocks).toBe(0);
  });

  it('refuses expired, used, superseded and unknown requests without bumping', async () => {
    const { store, join } = setup();
    const member = await join(tenantA, 'member', 'viewer');
    const expired = request(member.identityId, 'r-expired');
    await store.saveRecovery(expired);
    expect(await store.consumeRecovery(expired.id, expired.expiresAt)).toBe(false);
    expect(await store.consumeRecovery(randomUUID(), T0)).toBe(false);
    expect(await store.consumeRecovery('', T0)).toBe(false);
    expect(await store.consumeRecovery(expired.id, new Date(Number.NaN))).toBe(false);
    expect((await store.findIdentity(member.identityId))?.authorizationVersion).toBe(1);
  });

  it('validates input and requires an existing identity', async () => {
    const { store, join } = setup();
    const member = await join(tenantA, 'member', 'viewer');
    await expect(store.saveRecovery(request('ghost', 'r'))).rejects.toMatchObject({
      code: 'not_found',
    });
    const good = request(member.identityId, 'r-ok');
    const bad: RecoveryRequest[] = [
      { ...good, id: '' },
      { ...good, identityId: '' },
      { ...good, tokenHash: 'xyz' },
      { ...good, issuedAt: new Date(Number.NaN) },
      { ...good, expiresAt: new Date(Number.NaN) },
    ];
    for (const value of bad)
      await expect(store.saveRecovery(value)).rejects.toMatchObject({ code: 'invalid_input' });
    // supersededAt may be supplied; undefined becomes null.
    await store.saveRecovery({ ...good, supersededAt: T0 });
    expect((await store.findRecovery(good.tokenHash))?.supersededAt).toEqual(T0);
  });

  it('returns false when the request disappears before it is consumed', async () => {
    const { store, join, db } = setup();
    const member = await join(tenantA, 'member', 'viewer');
    const value = request(member.identityId, 'r1');
    await store.saveRecovery(value);
    db.intercept = (operation, table) => {
      if (operation === 'update' && table === 'opslog_identity_recoveries') {
        db.intercept = null;
        db.clear(RecoveryEntity);
      }
    };
    expect(await store.consumeRecovery(value.id, new Date(T0.getTime() + 1))).toBe(false);
  });
});

describe('retention', () => {
  it('purges only expired sessions, invitations and recovery requests', async () => {
    const { store, join, login, invite, clock } = setup();
    const member = await join(tenantA, 'member', 'viewer');
    await login(member.identityId, tenantA);
    await invite(tenantA, 'viewer');
    await store.saveRecovery({
      id: randomUUID(),
      identityId: member.identityId,
      tokenHash: hashOf('rec'),
      issuedAt: T0,
      expiresAt: new Date(T0.getTime() + HOUR),
      usedAt: null,
    });
    expect(await store.purgeExpired(new Date(T0.getTime() + HOUR))).toEqual({
      sessions: 0,
      invitations: 0,
      recoveries: 0,
    });
    clock.advance(0);
    expect(await store.purgeExpired(new Date(T0.getTime() + 73 * HOUR))).toEqual({
      sessions: 1,
      invitations: 2,
      recoveries: 1,
    });
    await expect(store.purgeExpired(new Date(Number.NaN))).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });
});

describe('error handling and privacy', () => {
  const SECRET = 'pii-subject-jane.doe@example.test';
  const failure = { errno: 2013, code: 'PROTOCOL_CONNECTION_LOST' };

  const scenarios: [string, string, (s: ReturnType<typeof setup>) => Promise<unknown>][] = [
    ['findIdentity', 'findOneBy', (s) => s.store.findIdentity('x')],
    ['findExternal', 'findOneBy', (s) => s.store.findExternal(PROVIDER, SECRET)],
    ['findMembership', 'findOneBy', (s) => s.store.findMembership(tenantA, 'x')],
    ['findRole', 'findOneBy', (s) => s.store.findRole(tenantA, 'x')],
    ['countActiveAdmins', 'count', (s) => s.store.countActiveAdmins(tenantA)],
    ['findSession', 'findOneBy', (s) => s.store.findSession(hashOf(SECRET))],
    ['findRecovery', 'findOneBy', (s) => s.store.findRecovery(hashOf(SECRET))],
    ['revokeSession', 'update', (s) => s.store.revokeSession('x', T0)],
    ['purgeExpired', 'delete', (s) => s.store.purgeExpired(T0)],
    [
      'createExternalIdentity',
      'insert',
      (s) =>
        s.store.createExternalIdentity(
          { id: 'i', status: 'active', mfa: 'disabled', authorizationVersion: 1, createdAt: T0 },
          {
            id: 'e',
            provider: PROVIDER,
            subject: SECRET,
            identityId: 'i',
            status: 'active',
            createdAt: T0,
          },
        ),
    ],
    [
      'activateInvitation',
      'findOneBy',
      (s) => s.store.activateInvitation(hashOf(SECRET), PROVIDER, SECRET, T0),
    ],
    ['consumeRecovery', 'findOneBy', (s) => s.store.consumeRecovery('x', T0)],
  ];

  it.each(scenarios)(
    '%s maps driver failures to a sanitized error without parameters',
    async (operation, statement, run) => {
      const harness = setup();
      harness.db.failNext(statement, failure, { leak: SECRET });
      const error = await rejection(run(harness));
      expect(error).toBeInstanceOf(IdentityStoreError);
      expect(error).toMatchObject({ code: 'unavailable', errno: 2013 });
      const rendered = [
        (error as Error).message,
        String((error as Error).stack),
        JSON.stringify(error),
        JSON.stringify(harness.events),
      ].join('|');
      expect(rendered).not.toContain(SECRET);
      expect(rendered).not.toContain('PROTOCOL_CONNECTION_LOST');
      expect(harness.events).toEqual([
        { operation, code: 'unavailable', errno: 2013, origin: null, frames: [] },
      ]);
      expect((error as { cause?: unknown }).cause).toBeUndefined();
    },
  );

  it('maps constraint failures to integrity errors and unique violations to conflicts', async () => {
    const { store, db, events } = setup();
    db.failNext('findOneBy', { errno: 1452, code: 'ER_NO_REFERENCED_ROW_2' });
    await expect(store.findIdentity('x')).rejects.toMatchObject({ code: 'integrity', errno: 1452 });
    db.failNext('findOneBy', { errno: 1451, code: 'ER_ROW_IS_REFERENCED_2' });
    await expect(store.findIdentity('x')).rejects.toMatchObject({ code: 'integrity' });
    db.failNext('findOneBy', { errno: 3819, code: 'ER_CHECK_CONSTRAINT_VIOLATED' });
    await expect(store.findIdentity('x')).rejects.toMatchObject({ code: 'integrity', errno: 3819 });
    db.failNext('findOneBy', { errno: 1062, code: 'ER_DUP_ENTRY' }, { leak: SECRET });
    const duplicate = await rejection(store.findIdentity('x'));
    expect(duplicate).toBeInstanceOf(AuthError);
    expect(JSON.stringify(duplicate) + String((duplicate as Error).stack)).not.toContain(SECRET);
    expect(events.map((event) => event.code)).toEqual(['integrity', 'integrity', 'integrity']);
  });

  it('retries deadlocks and lock-wait timeouts, then reports contention', async () => {
    const { store, db, join, events } = setup();
    const a = await join(tenantA, 'a', ADMIN_ROLE);
    await join(tenantA, 'b', ADMIN_ROLE);
    db.failNext('findOne', DEADLOCK, { entity: TenantLockEntity });
    db.failNext('findOne', LOCK_TIMEOUT, { entity: TenantLockEntity });
    expect(await store.revokeMembership(tenantA, a.identityId)).toBe(true);
    expect(events).toEqual([]);
    expect(
      db.statements.filter((s) => s === 'findOne opslog_identity_tenant_locks FOR UPDATE'),
    ).toHaveLength(3);
    // The failed attempts were rolled back completely (membership revoked exactly once).
    expect((await store.findIdentity(a.identityId))?.authorizationVersion).toBe(2);

    const c = await join(tenantA, 'c', ADMIN_ROLE);
    db.failNext('findOne', DEADLOCK, { entity: TenantLockEntity, times: 3 });
    await expect(store.revokeMembership(tenantA, c.identityId)).rejects.toMatchObject({
      code: 'contention',
      errno: 1213,
    });
    expect(events).toEqual([
      { operation: 'revokeMembership', code: 'contention', errno: 1213, origin: null, frames: [] },
    ]);
    expect(await store.findMembership(tenantA, c.identityId)).toMatchObject({ status: 'active' });
  });

  it('keeps programming errors distinguishable without exposing their message', async () => {
    const { store, db, events } = setup();
    db.intercept = () => {
      db.intercept = null;
      throw new TypeError(`boom ${SECRET}`);
    };
    const error = await rejection(store.findIdentity('x'));
    expect(error).toBeInstanceOf(IdentityStoreError);
    expect(error).toMatchObject({ code: 'internal', errno: null, origin: 'TypeError' });
    const frames = (error as IdentityStoreError).frames;
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((frame) => frame.startsWith('at '))).toBe(true);
    const rendered = [(error as Error).message, JSON.stringify(error), JSON.stringify(events)].join(
      '|',
    );
    expect(rendered).not.toContain(SECRET);
    expect(rendered).not.toContain('boom');
    expect(events).toEqual([
      { operation: 'findIdentity', code: 'internal', errno: null, origin: 'TypeError', frames },
    ]);
  });

  it('works without an error observer and with non-driver exceptions', async () => {
    const db = new FakeDatabase();
    const store = new TypeOrmIdentityStore(asDataSource(db));
    db.failNext('findOneBy', failure);
    await expect(store.findIdentity('x')).rejects.toBeInstanceOf(IdentityStoreError);
    expect(await store.findIdentity('x')).toBeNull();
    const events: StoreErrorEvent[] = [];
    const observed = new TypeOrmIdentityStore(asDataSource(db), { onError: (e) => events.push(e) });
    db.failNext('findOneBy', failure);
    await expect(observed.findIdentity('x')).rejects.toBeInstanceOf(IdentityStoreError);
    expect(events).toHaveLength(1);
  });

  it('always uses READ COMMITTED transactions and the port type is satisfied', async () => {
    const { store, db, join } = setup();
    const port: IdentityStore = store;
    expect(port).toBe(store);
    const a = await join(tenantA, 'a', ADMIN_ROLE);
    await join(tenantA, 'b', ADMIN_ROLE);
    await store.revokeMembership(tenantA, a.identityId);
    expect(db.transactions).toBeGreaterThan(0);
    expect(new Set(db.isolations)).toEqual(new Set(['READ COMMITTED']));
  });
});

describe('custom roles', () => {
  const copy = (id: string, name: string, permissions: readonly string[] = ['view', 'create']) => ({
    id,
    name,
    permissions,
  });

  it('stores a role with its permissions in order and lists roles oldest first', async () => {
    const { store, join, clock, db } = setup();
    await join(tenantA, 'admin-a', ADMIN_ROLE);
    expect(await store.listCustomRoles(tenantA)).toEqual([]);
    expect(await store.createCustomRole(tenantA, copy('custom-1', 'Regional'), 50)).toBe('created');
    clock.advance(1000);
    // Created later but sorts before alphabetically: order follows creation, not the id.
    expect(
      await store.createCustomRole(tenantA, copy('custom-0', ' Otro ', ['view_pii', 'view']), 50),
    ).toBe('created');
    expect(await store.listCustomRoles(tenantA)).toEqual([
      { id: 'custom-1', name: 'Regional', permissions: ['view', 'create'] },
      { id: 'custom-0', name: 'Otro', permissions: ['view_pii', 'view'] },
    ]);
    expect(await store.findCustomRole(tenantA, 'custom-0')).toEqual({
      id: 'custom-0',
      name: 'Otro',
      permissions: ['view_pii', 'view'],
    });
    expect(db.committed(RoleEntity).map((row) => row.nameKey)).toEqual(['regional', 'otro']);
    expect(db.committed(RolePermissionEntity)).toHaveLength(4);
  });

  it('orders roles created in the same instant by id and allows an empty permission set', async () => {
    const { store, join } = setup();
    await join(tenantA, 'admin-a', ADMIN_ROLE);
    await store.createCustomRole(tenantA, copy('role-b', 'B', []), 50);
    await store.createCustomRole(tenantA, copy('role-a', 'A', []), 50);
    await store.createCustomRole(tenantA, copy('role-c', 'C', []), 50);
    expect((await store.listCustomRoles(tenantA)).map((role) => role.id)).toEqual([
      'role-a',
      'role-b',
      'role-c',
    ]);
    expect((await store.findCustomRole(tenantA, 'role-a'))?.permissions).toEqual([]);
  });

  it('keeps names unique per tenant, case-insensitively, and enforces the per-tenant limit', async () => {
    const { store, join } = setup();
    await join(tenantA, 'admin-a', ADMIN_ROLE);
    await join(tenantB, 'admin-b', ADMIN_ROLE);
    expect(await store.createCustomRole(tenantA, copy('r1', 'Regional'), 2)).toBe('created');
    expect(await store.createCustomRole(tenantA, copy('r2', '  REGIONAL '), 2)).toBe('name_taken');
    expect(await store.createCustomRole(tenantA, copy('r2', 'Otro'), 2)).toBe('created');
    expect(await store.createCustomRole(tenantA, copy('r3', 'Tercero'), 2)).toBe('limit_reached');
    // The limit is checked before the name, and neither leaks across tenants.
    expect(await store.createCustomRole(tenantA, copy('r4', 'Regional'), 2)).toBe('limit_reached');
    expect(await store.createCustomRole(tenantB, copy('r1', 'Regional'), 2)).toBe('created');
    expect(await store.listCustomRoles(tenantA)).toHaveLength(2);
    expect(await store.listCustomRoles(tenantB)).toHaveLength(1);
  });

  it('never shows a role to another tenant, even by id', async () => {
    const { store, join } = setup();
    await join(tenantA, 'admin-a', ADMIN_ROLE);
    await join(tenantB, 'admin-b', ADMIN_ROLE);
    await store.createCustomRole(tenantA, copy('secret', 'Solo A'), 50);
    expect(await store.findCustomRole(tenantB, 'secret')).toBeNull();
    expect(await store.listCustomRoles(tenantB)).toEqual([]);
    expect(await store.findCustomRole(tenantA, 'unknown')).toBeNull();
    expect(await store.findCustomRole('', 'secret')).toBeNull();
    expect(await store.findCustomRole(tenantA, '')).toBeNull();
    expect(await store.listCustomRoles('')).toEqual([]);
    // The same role id can exist in two tenants without colliding.
    expect(await store.createCustomRole(tenantB, copy('secret', 'Solo B', ['view']), 50)).toBe(
      'created',
    );
    expect((await store.findCustomRole(tenantA, 'secret'))?.name).toBe('Solo A');
    expect((await store.findCustomRole(tenantB, 'secret'))?.name).toBe('Solo B');
  });

  it('rejects malformed input before touching the database', async () => {
    const { store, join, db } = setup();
    await join(tenantA, 'admin-a', ADMIN_ROLE);
    const statementsBefore = db.statements.length;
    const tooMany = Array.from({ length: CUSTOM_ROLE_LIMITS.permissions + 1 }, (_, i) =>
      i % 2 ? `p${'a'.repeat(i)}` : `q${'b'.repeat(i)}`,
    );
    const bad: [string, string, unknown, number][] = [
      ['empty tenant', '', copy('r', 'N'), 50],
      ['uppercase id', tenantA, copy('R', 'N'), 50],
      ['id too long', tenantA, copy('r'.repeat(65), 'N'), 50],
      ['blank name', tenantA, copy('r', '   '), 50],
      ['long name', tenantA, copy('r', 'n'.repeat(CUSTOM_ROLE_LIMITS.nameLength + 1)), 50],
      ['non-string name', tenantA, { id: 'r', name: 7, permissions: [] }, 50],
      ['bad permission', tenantA, copy('r', 'N', ['View']), 50],
      ['non-string permission', tenantA, copy('r', 'N', [7 as never]), 50],
      ['duplicate permission', tenantA, copy('r', 'N', ['view', 'view']), 50],
      ['too many permissions', tenantA, copy('r', 'N', tooMany), 50],
      ['permissions not a list', tenantA, { id: 'r', name: 'N', permissions: 'view' }, 50],
      ['zero limit', tenantA, copy('r', 'N'), 0],
      ['fractional limit', tenantA, copy('r', 'N'), 1.5],
    ];
    for (const [label, tenant, role, limit] of bad)
      await expect(
        store.createCustomRole(tenant, role as never, limit),
        label,
      ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(db.statements).toHaveLength(statementsBefore);
  });

  it('answers not_found for a tenant without memberships and creates no lock row for it', async () => {
    const { store, db } = setup();
    await expect(store.createCustomRole('ghost', copy('r', 'N'), 50)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(db.committed(TenantLockEntity)).toEqual([]);
    expect(db.committed(RoleEntity)).toEqual([]);
  });

  it('serializes concurrent creations of one name and of the last free slot', async () => {
    for (let round = 0; round < 10; round += 1) {
      const { store, join, db } = setup();
      await join(tenantA, `admin-${round}`, ADMIN_ROLE);
      const sameName = await Promise.all(
        ['x1', 'x2', 'x3'].map((id) => store.createCustomRole(tenantA, copy(id, 'Igual'), 50)),
      );
      expect(sameName.filter((outcome) => outcome === 'created')).toHaveLength(1);
      expect(sameName.filter((outcome) => outcome === 'name_taken')).toHaveLength(2);
      const slots = await Promise.all(
        ['y1', 'y2', 'y3', 'y4'].map((id) => store.createCustomRole(tenantA, copy(id, id), 3)),
      );
      expect(slots.filter((outcome) => outcome === 'created')).toHaveLength(2);
      expect(slots.filter((outcome) => outcome === 'limit_reached')).toHaveLength(2);
      expect(await store.listCustomRoles(tenantA)).toHaveLength(3);
      expect(db.deadlocks).toBe(0);
    }
  });

  it('does not make creations of different tenants wait for each other', async () => {
    const { store, join, db } = setup();
    await join(tenantA, 'admin-a', ADMIN_ROLE);
    await join(tenantB, 'admin-b', ADMIN_ROLE);
    const outcomes = await Promise.all([
      store.createCustomRole(tenantA, copy('r', 'Igual'), 50),
      store.createCustomRole(tenantB, copy('r', 'Igual'), 50),
    ]);
    expect(outcomes).toEqual(['created', 'created']);
    expect(db.deadlocks).toBe(0);
  });

  it('takes the tenant lock before it reads or writes any role row, in one READ COMMITTED transaction', async () => {
    const { store, join, db } = setup();
    await join(tenantA, 'admin-a', ADMIN_ROLE);
    db.statements.length = 0;
    await store.createCustomRole(tenantA, copy('r', 'N', ['view']), 50);
    const at = (statement: string) => db.statements.indexOf(statement);
    const lock = at(`findOne ${IDENTITY_TABLES.tenantLocks} FOR UPDATE`);
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(at(`find ${IDENTITY_TABLES.roles}`)).toBeGreaterThan(lock);
    expect(at(`insert ${IDENTITY_TABLES.roles}`)).toBeGreaterThan(
      at(`find ${IDENTITY_TABLES.roles}`),
    );
    expect(at(`insert ${IDENTITY_TABLES.rolePermissions}`)).toBeGreaterThan(
      at(`insert ${IDENTITY_TABLES.roles}`),
    );
    expect(db.isolations.at(-1)).toBe('READ COMMITTED');
  });

  it('commits the role and its permissions together or not at all', async () => {
    const { store, join, db } = setup();
    await join(tenantA, 'admin-a', ADMIN_ROLE);
    db.failNext(
      'insert',
      { errno: 1114, code: 'ER_RECORD_FILE_FULL' },
      { entity: RolePermissionEntity, leak: 'sub-secret' },
    );
    const error = await rejection(store.createCustomRole(tenantA, copy('r', 'N'), 50));
    expect(error).toBeInstanceOf(IdentityStoreError);
    expect(JSON.stringify(error)).not.toContain('sub-secret');
    expect(db.committed(RoleEntity)).toEqual([]);
    expect(db.committed(RolePermissionEntity)).toEqual([]);
    expect(await store.createCustomRole(tenantA, copy('r', 'N'), 50)).toBe('created');
  });

  it('keys roles and permissions by tenant with foreign keys that cannot be bypassed', async () => {
    const { store, join, db } = setup();
    await join(tenantA, 'admin-a', ADMIN_ROLE);
    await join(tenantB, 'admin-b', ADMIN_ROLE);
    await store.createCustomRole(tenantA, copy('r', 'N', ['view']), 50);
    const roles = db.getRepository(RoleEntity);
    const permissions = db.getRepository(RolePermissionEntity);
    // A role needs the lock row of its own tenant.
    await expect(
      roles.insert({ tenantId: 'nobody', id: 'x', name: 'x', nameKey: 'x', createdAt: T0 }),
    ).rejects.toMatchObject({ driverError: { errno: 1452 } });
    // A permission cannot attach to a role of another tenant: the key is (tenant, role).
    await expect(
      permissions.insert({ tenantId: tenantB, roleId: 'r', permission: 'view', position: 0 }),
    ).rejects.toMatchObject({ driverError: { errno: 1452 } });
    // Two roles of one tenant cannot share a (case-folded) name at the database level either.
    await expect(
      roles.insert({ tenantId: tenantA, id: 'dup', name: 'n', nameKey: 'n', createdAt: T0 }),
    ).rejects.toMatchObject({ driverError: { errno: 1062 } });
  });

  it('reports read failures without data', async () => {
    const { store, join, db, events } = setup();
    await join(tenantA, 'admin-a', ADMIN_ROLE);
    await store.createCustomRole(tenantA, copy('r', 'N'), 50);
    db.failNext('find', { errno: 2013, code: 'PROTOCOL_CONNECTION_LOST' }, { leak: 'tenant-a' });
    expect(await rejection(store.listCustomRoles(tenantA))).toBeInstanceOf(IdentityStoreError);
    db.failNext(
      'findOneBy',
      { errno: 2013, code: 'PROTOCOL_CONNECTION_LOST' },
      { leak: 'tenant-a' },
    );
    expect(await rejection(store.findCustomRole(tenantA, 'r'))).toBeInstanceOf(IdentityStoreError);
    expect(events.map((event) => event.operation)).toEqual(['listCustomRoles', 'findCustomRole']);
    expect(JSON.stringify(events)).not.toContain('tenant-a');
  });
});
