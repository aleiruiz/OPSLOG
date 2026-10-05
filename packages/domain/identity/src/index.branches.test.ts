import { describe, expect, it } from 'vitest';
import {
  AuthError,
  IdentityService,
  InMemoryIdentityStore,
  type Identity,
  type Invitation,
  type Membership,
  type RecoveryRequest,
  type TenantContext,
} from './index.js';

const notifier = { deliver: async () => undefined };
const T0 = '2026-10-04T00:00:00.000Z';
const clock = (start = T0) => {
  let now = new Date(start);
  return { read: () => now, set: (value: string) => void (now = new Date(value)) };
};
const enroll = async (auth: IdentityService, tenantId: string, subject: string) => {
  const invitation = await auth.issueInvitation(tenantId);
  await auth.activateInvitation(invitation.token, 'oidc-test', subject);
  return invitation.identityId;
};
const code = (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (error: unknown) => (error instanceof AuthError ? error.code : 'other'),
  );

const identityOf = (id: string, status: Identity['status'] = 'pending'): Identity => ({
  id,
  status,
  mfa: 'disabled',
  authorizationVersion: 1,
  createdAt: new Date(T0),
});
const membershipOf = (tenantId: string, identityId: string): Membership => ({
  id: `m-${tenantId}-${identityId}`,
  tenantId,
  identityId,
  status: 'pending',
  createdAt: new Date(T0),
  activatedAt: null,
});
const invitationOf = (id: string, tenantId: string, identityId: string): Invitation => ({
  id,
  tenantId,
  identityId,
  tokenHash: id.padEnd(64, '0').replace(/[^0-9a-f]/g, 'a'),
  expiresAt: new Date('2026-12-01T00:00:00.000Z'),
  consumedAt: null,
});

describe('InMemoryIdentityStore lookups and guards', () => {
  it('returns null for unknown records', async () => {
    const store = new InMemoryIdentityStore();
    await expect(store.findIdentity('x')).resolves.toBeNull();
    await expect(store.findExternal('p', 's')).resolves.toBeNull();
    await expect(store.findMembership('t', 'i')).resolves.toBeNull();
    await expect(store.findRecovery('aa')).resolves.toBeNull();
    await expect(store.findSession('aa')).resolves.toBeNull();
    await expect(store.activateInvitation('aa', 'p', 's', new Date(T0))).resolves.toBeNull();
    await expect(store.consumeRecovery('x', new Date(T0))).resolves.toBe(false);
    await expect(store.revokeMembership('t', 'i')).resolves.toBe(false);
    await expect(store.revokeSession('x', new Date(T0))).resolves.toBe(false);
  });

  it('rejects invitations whose identity, membership and tenant do not agree', async () => {
    const store = new InMemoryIdentityStore();
    const identity = identityOf('id-1');
    await expect(
      store.createInvitation(identity, membershipOf('t', 'other'), invitationOf('a1', 't', 'id-1')),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      store.createInvitation(identity, membershipOf('t', 'id-1'), invitationOf('a2', 't', 'other')),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      store.createInvitation(
        identity,
        membershipOf('t', 'id-1'),
        invitationOf('a3', 'other-tenant', 'id-1'),
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('refuses to invite an active member and keeps an existing pending membership', async () => {
    const auth = new IdentityService(new InMemoryIdentityStore(), notifier);
    const id = await enroll(auth, 'tenant-a', 'member');
    await expect(code(auth.issueInvitation('tenant-a', id))).resolves.toBe('conflict');
    const pending = await auth.issueInvitation('tenant-b');
    const again = await auth.issueInvitation('tenant-b', pending.identityId);
    await expect(
      auth.activateInvitation(again.token, 'oidc-test', 'pending-subject'),
    ).resolves.toMatchObject({ membership: { id: expect.any(String), status: 'active' } });
  });

  it('refuses activation for a revoked identity or a membership that is not pending', async () => {
    const store = new InMemoryIdentityStore();
    const auth = new IdentityService(store, notifier);
    const invitation = await auth.issueInvitation('tenant-a');
    await store.revokeMembership('tenant-a', invitation.identityId);
    await expect(
      code(auth.activateInvitation(invitation.token, 'oidc-test', 'late')),
    ).resolves.toBe('unauthorized');
  });

  it('rejects an activation by a subject linked to another identity or a different subject', async () => {
    const auth = new IdentityService(new InMemoryIdentityStore(), notifier);
    await enroll(auth, 'tenant-a', 'owner-subject');
    const second = await auth.issueInvitation('tenant-a');
    await expect(
      code(auth.activateInvitation(second.token, 'oidc-test', 'owner-subject')),
    ).resolves.toBe('unauthorized');
    const active = await auth.provisionExternal('oidc-test', 'active-user');
    const reinvite = await auth.issueInvitation('tenant-c', active.id);
    await expect(
      code(auth.activateInvitation(reinvite.token, 'oidc-test', 'intruder')),
    ).resolves.toBe('unauthorized');
    await expect(
      auth.activateInvitation(reinvite.token, 'oidc-test', 'active-user'),
    ).resolves.toMatchObject({ identity: { id: active.id } });
  });

  it('refuses an expired or already consumed invitation', async () => {
    const time = clock();
    const auth = new IdentityService(new InMemoryIdentityStore(), notifier, undefined, time.read);
    const invitation = await auth.issueInvitation('tenant-a', undefined, 1000);
    time.set('2026-10-04T00:00:01.000Z');
    await expect(code(auth.activateInvitation(invitation.token, 'oidc-test', 's'))).resolves.toBe(
      'unauthorized',
    );
    const fresh = await auth.issueInvitation('tenant-a');
    await auth.activateInvitation(fresh.token, 'oidc-test', 's2');
    await expect(code(auth.activateInvitation(fresh.token, 'oidc-test', 's2'))).resolves.toBe(
      'unauthorized',
    );
  });
});

describe('IdentityService input and state guards', () => {
  it('resolveExternal validates input and requires an active linked identity', async () => {
    const auth = new IdentityService(new InMemoryIdentityStore(), notifier);
    await expect(code(auth.resolveExternal('', 's'))).resolves.toBe('invalid_input');
    await expect(code(auth.resolveExternal('p', ' '))).resolves.toBe('invalid_input');
    await expect(code(auth.resolveExternal('p', 'x'.repeat(201)))).resolves.toBe('invalid_input');
    await expect(code(auth.resolveExternal('oidc-test', 'unknown'))).resolves.toBe('unauthorized');
    const id = await enroll(auth, 'tenant-a', 'known');
    await expect(auth.resolveExternal('oidc-test', 'known')).resolves.toMatchObject({ id });
  });

  it('resolveExternal and provisionExternal reject a link whose identity is missing or inactive', async () => {
    class Broken extends InMemoryIdentityStore {
      public mode: 'missing' | 'revoked' | 'pending' = 'missing';
      public override async findIdentity(id: string) {
        const found = await super.findIdentity(id);
        if (!found || this.mode === 'missing') return null;
        return { ...found, status: this.mode };
      }
    }
    const store = new Broken();
    const auth = new IdentityService(store, notifier);
    store.mode = 'pending';
    await auth.provisionExternal('oidc-test', 'u');
    for (const mode of ['missing', 'revoked', 'pending'] as const) {
      store.mode = mode;
      await expect(code(auth.resolveExternal('oidc-test', 'u'))).resolves.toBe('unauthorized');
    }
    for (const mode of ['missing', 'revoked'] as const) {
      store.mode = mode;
      await expect(code(auth.provisionExternal('oidc-test', 'u'))).resolves.toBe('unauthorized');
    }
  });

  it('provisionExternal validates input and rejects when the winning identity is unusable', async () => {
    const auth = new IdentityService(new InMemoryIdentityStore(), notifier);
    await expect(code(auth.provisionExternal('', 's'))).resolves.toBe('invalid_input');
    await expect(code(auth.provisionExternal('p', ''))).resolves.toBe('invalid_input');

    class Racy extends InMemoryIdentityStore {
      public override async createExternalIdentity(
        identity: Identity,
        external: Parameters<InMemoryIdentityStore['createExternalIdentity']>[1],
      ) {
        await super.createExternalIdentity(identity, external);
        return { ...external, identityId: 'vanished' };
      }
    }
    await expect(
      code(new IdentityService(new Racy(), notifier).provisionExternal('p', 's')),
    ).resolves.toBe('unauthorized');
  });

  it('issueInvitation validates tenant, identity and ttl', async () => {
    const auth = new IdentityService(new InMemoryIdentityStore(), notifier);
    await expect(code(auth.issueInvitation(''))).resolves.toBe('invalid_input');
    await expect(code(auth.issueInvitation('t', ''))).resolves.toBe('invalid_input');
    await expect(code(auth.issueInvitation('t', 'i', 0))).resolves.toBe('invalid_input');
    await expect(code(auth.issueInvitation('t', 'i', Number.NaN))).resolves.toBe('invalid_input');
    await expect(code(auth.issueInvitation('t', 'i', Infinity))).resolves.toBe('invalid_input');
  });

  it('issueInvitation conflicts on a revoked identity', async () => {
    class Revoked extends InMemoryIdentityStore {
      public revoked = false;
      public override async findIdentity(id: string) {
        const found = await super.findIdentity(id);
        return found && this.revoked ? { ...found, status: 'revoked' as const } : found;
      }
    }
    const store = new Revoked();
    const auth = new IdentityService(store, notifier);
    const identity = await auth.provisionExternal('p', 's');
    store.revoked = true;
    await expect(code(auth.issueInvitation('t', identity.id))).resolves.toBe('conflict');
    const direct = new InMemoryIdentityStore();
    const gone = identityOf('revoked-id', 'revoked');
    await direct.createExternalIdentity(gone, {
      id: 'e1',
      provider: 'p',
      subject: 's',
      identityId: gone.id,
      status: 'revoked',
      createdAt: new Date(T0),
    });
    await expect(
      direct.createInvitation(
        identityOf(gone.id),
        membershipOf('t', gone.id),
        invitationOf('b1', 't', gone.id),
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('activateInvitation rejects empty token, provider or subject', async () => {
    const auth = new IdentityService(new InMemoryIdentityStore(), notifier);
    await expect(code(auth.activateInvitation('', 'p', 's'))).resolves.toBe('unauthorized');
    await expect(code(auth.activateInvitation('t', '', 's'))).resolves.toBe('unauthorized');
    await expect(code(auth.activateInvitation('t', 'p', ''))).resolves.toBe('unauthorized');
  });

  it('revokeMembership validates input and reports unknown or repeated revocations', async () => {
    const auth = new IdentityService(new InMemoryIdentityStore(), notifier);
    await expect(code(auth.revokeMembership('', 'i'))).resolves.toBe('invalid_input');
    await expect(code(auth.revokeMembership('t', ''))).resolves.toBe('invalid_input');
    await expect(code(auth.revokeMembership('t', 'nobody'))).resolves.toBe('not_found');
    const id = await enroll(auth, 't', 'who');
    await expect(auth.revokeMembership('t', id)).resolves.toBeUndefined();
    await expect(code(auth.revokeMembership('t', id))).resolves.toBe('not_found');
  });

  it('createSession validates input and requires an active identity', async () => {
    const auth = new IdentityService(new InMemoryIdentityStore(), notifier);
    await expect(code(auth.createSession('', 't'))).resolves.toBe('invalid_input');
    await expect(code(auth.createSession('i', ''))).resolves.toBe('invalid_input');
    await expect(code(auth.createSession('i', 't', 0))).resolves.toBe('invalid_input');
    await expect(code(auth.createSession('i', 't', Infinity))).resolves.toBe('invalid_input');
    await expect(code(auth.createSession('unknown', 't'))).resolves.toBe('unauthorized');
    const invitation = await auth.issueInvitation('t');
    await expect(code(auth.createSession(invitation.identityId, 't'))).resolves.toBe(
      'unauthorized',
    );
  });

  it('requirePermission denies an empty tenant, a system actor and an ungranted permission', async () => {
    const auth = new IdentityService(new InMemoryIdentityStore(), notifier);
    const ctx = (over: Partial<TenantContext>): TenantContext => ({
      tenantId: 't',
      actor: { subject: 'a', kind: 'user' },
      authorizationVersion: 1,
      correlationId: 'c',
      ...over,
    });
    await expect(auth.requirePermission(ctx({}), 'view', ['view'])).resolves.toBeUndefined();
    await expect(
      code(auth.requirePermission(ctx({ tenantId: '' }), 'view', ['view'])),
    ).resolves.toBe('forbidden');
    await expect(
      code(
        auth.requirePermission(ctx({ actor: { subject: 's', kind: 'system' } }), 'view', ['view']),
      ),
    ).resolves.toBe('forbidden');
    await expect(code(auth.requirePermission(ctx({}), 'delete', ['view']))).resolves.toBe(
      'forbidden',
    );
  });
});

describe('session authentication and revocation', () => {
  it('rejects empty input, unknown, revoked and expired sessions', async () => {
    const time = clock();
    const auth = new IdentityService(new InMemoryIdentityStore(), notifier, undefined, time.read);
    const id = await enroll(auth, 't', 's');
    await expect(code(auth.authenticate('', 'c'))).resolves.toBe('unauthorized');
    await expect(code(auth.authenticate('tok', ''))).resolves.toBe('unauthorized');
    await expect(code(auth.authenticate('unknown', 'c'))).resolves.toBe('unauthorized');
    const revoked = await auth.createSession(id, 't');
    await auth.revoke(revoked.token);
    await expect(code(auth.authenticate(revoked.token, 'c'))).resolves.toBe('unauthorized');
    const short = await auth.createSession(id, 't', 1000);
    await expect(auth.authenticate(short.token, 'c')).resolves.toMatchObject({ tenantId: 't' });
    time.set('2026-10-04T00:00:01.000Z');
    await expect(code(auth.authenticate(short.token, 'c'))).resolves.toBe('unauthorized');
  });

  it('rejects sessions of identities with a bumped authorization version or no active membership', async () => {
    const auth = new IdentityService(new InMemoryIdentityStore(), notifier);
    const id = await enroll(auth, 't', 's');
    const noMembership = await auth.createSession(id, 'other-tenant');
    await expect(code(auth.authenticate(noMembership.token, 'c'))).resolves.toBe('unauthorized');
    const session = await auth.createSession(id, 't');
    await auth.revokeMembership('t', id);
    await expect(code(auth.authenticate(session.token, 'c'))).resolves.toBe('unauthorized');
  });

  it('rejects sessions whose identity vanished or is no longer active', async () => {
    class Switch extends InMemoryIdentityStore {
      public mode: 'ok' | 'missing' | 'revoked' = 'ok';
      public override async findIdentity(id: string) {
        const found = await super.findIdentity(id);
        if (!found || this.mode === 'ok') return found;
        return this.mode === 'missing' ? null : { ...found, status: 'revoked' as const };
      }
    }
    const store = new Switch();
    const auth = new IdentityService(store, notifier);
    const id = await enroll(auth, 't', 's');
    const session = await auth.createSession(id, 't');
    for (const mode of ['missing', 'revoked'] as const) {
      store.mode = mode;
      await expect(code(auth.authenticate(session.token, 'c'))).resolves.toBe('unauthorized');
    }
  });

  it('revoke validates the token and silently ignores unknown tokens', async () => {
    const auth = new IdentityService(new InMemoryIdentityStore(), notifier);
    await expect(code(auth.revoke(''))).resolves.toBe('invalid_input');
    await expect(code(auth.revoke(7 as unknown as string))).resolves.toBe('invalid_input');
    await expect(auth.revoke('never-issued')).resolves.toBeUndefined();
  });

  it('revoking an already revoked session leaves it revoked', async () => {
    const store = new InMemoryIdentityStore();
    const auth = new IdentityService(store, notifier);
    const id = await enroll(auth, 't', 's');
    const session = await auth.createSession(id, 't');
    await auth.revoke(session.token);
    await expect(auth.revoke(session.token)).resolves.toBeUndefined();
    await expect(code(auth.authenticate(session.token, 'c'))).resolves.toBe('unauthorized');
  });
});

describe('account recovery', () => {
  const setup = (options = {}) => {
    const time = clock();
    const store = new InMemoryIdentityStore();
    const deliveries: string[] = [];
    const errors: unknown[] = [];
    const auth = new IdentityService(
      store,
      { deliver: async (_id, token) => void deliveries.push(token) },
      undefined,
      time.read,
      { onBackgroundError: (e) => void errors.push(e), ...options },
    );
    return { time, store, auth, deliveries, errors };
  };

  it('validates recovery request input', async () => {
    const { auth } = setup();
    await expect(code(auth.requestRecovery(''))).resolves.toBe('invalid_input');
    await expect(code(auth.requestRecovery('i', 0))).resolves.toBe('invalid_input');
    await expect(code(auth.requestRecovery('i', Infinity))).resolves.toBe('invalid_input');
  });

  it('answers unknown identities identically without delivering anything', async () => {
    const { auth, deliveries } = setup();
    await expect(auth.requestRecovery('ghost')).resolves.toEqual({ accepted: true });
    await auth.settled();
    expect(deliveries).toEqual([]);
  });

  it('throttles repeated requests within the minimum interval', async () => {
    const { auth, time, deliveries } = setup();
    const id = await enroll(auth, 't', 's');
    await auth.requestRecovery(id);
    await auth.requestRecovery(id);
    await auth.settled();
    expect(deliveries).toHaveLength(1);
    time.set('2026-10-04T00:01:00.000Z');
    await auth.requestRecovery(id);
    await auth.settled();
    expect(deliveries).toHaveLength(2);
  });

  it('releases the throttle slot when the first delivery fails so a retry is delivered', async () => {
    const time = clock();
    const errors: unknown[] = [];
    const deliveries: string[] = [];
    let fail = true;
    const auth = new IdentityService(
      new InMemoryIdentityStore(),
      {
        deliver: async (_id, token) => {
          if (fail) throw new Error('smtp down');
          deliveries.push(token);
        },
      },
      undefined,
      time.read,
      { onBackgroundError: (e) => void errors.push(e) },
    );
    const id = await enroll(auth, 't', 's');
    await auth.requestRecovery(id);
    await auth.settled();
    expect(errors).toHaveLength(1);
    fail = false;
    await auth.requestRecovery(id);
    await auth.settled();
    expect(deliveries).toHaveLength(1);
  });

  it('restores the previous throttle timestamp when a later delivery fails', async () => {
    const time = clock();
    const deliveries: string[] = [];
    let fail = false;
    const errors: unknown[] = [];
    const auth = new IdentityService(
      new InMemoryIdentityStore(),
      {
        deliver: async (_id, token) => {
          if (fail) throw new Error('smtp down');
          deliveries.push(token);
        },
      },
      undefined,
      time.read,
      { onBackgroundError: (e) => void errors.push(e) },
    );
    const id = await enroll(auth, 't', 's');
    await auth.requestRecovery(id);
    await auth.settled();
    time.set('2026-10-04T00:02:00.000Z');
    fail = true;
    await auth.requestRecovery(id);
    await auth.settled();
    expect(errors).toHaveLength(1);
    fail = false;
    time.set('2026-10-04T00:02:30.000Z');
    await auth.requestRecovery(id);
    await auth.settled();
    // 00:02:30 is only 30 s after the failed attempt, but the slot rolled back to 00:00:00, so it is delivered.
    expect(deliveries).toHaveLength(2);
  });

  it('works without an error callback when background delivery fails', async () => {
    const auth = new IdentityService(new InMemoryIdentityStore(), {
      deliver: async () => {
        throw new Error('down');
      },
    });
    const id = await enroll(auth, 't', 's');
    await expect(auth.requestRecovery(id)).resolves.toEqual({ accepted: true });
    await expect(auth.settled()).resolves.toBeUndefined();
  });

  it('prunes expired throttle entries once the table reaches 1000 identities', async () => {
    const { auth, time, deliveries } = setup();
    for (let i = 0; i < 1000; i += 1) {
      const identity = await auth.provisionExternal('oidc-test', `bulk-${i}`);
      await auth.requestRecovery(identity.id);
    }
    await auth.settled();
    expect(deliveries).toHaveLength(1000);
    time.set('2026-10-04T00:05:00.000Z');
    const fresh = await auth.provisionExternal('oidc-test', 'bulk-fresh');
    await auth.requestRecovery(fresh.id);
    await auth.settled();
    expect(deliveries).toHaveLength(1001);
    // The prune removed the stale entries, so an old identity is delivered again immediately.
    const first = await auth.provisionExternal('oidc-test', 'bulk-0');
    await auth.requestRecovery(first.id);
    await auth.settled();
    expect(deliveries).toHaveLength(1002);
  });

  it('keeps unexpired throttle entries when pruning', async () => {
    const { auth, time, deliveries } = setup();
    for (let i = 0; i < 1000; i += 1) {
      const identity = await auth.provisionExternal('oidc-test', `keep-${i}`);
      await auth.requestRecovery(identity.id);
    }
    await auth.settled();
    time.set('2026-10-04T00:00:10.000Z');
    const fresh = await auth.provisionExternal('oidc-test', 'keep-fresh');
    await auth.requestRecovery(fresh.id);
    const again = await auth.provisionExternal('oidc-test', 'keep-0');
    await auth.requestRecovery(again.id);
    await auth.settled();
    expect(deliveries).toHaveLength(1001);
  });

  it('consumeRecovery validates, rejects used, expired, superseded and unknown tokens', async () => {
    const { auth, time, deliveries } = setup();
    await expect(code(auth.consumeRecovery(''))).resolves.toBe('invalid_input');
    await expect(code(auth.consumeRecovery('nope'))).resolves.toBe('unauthorized');
    const id = await enroll(auth, 't', 's');
    await auth.requestRecovery(id, 1000);
    await auth.settled();
    time.set('2026-10-04T00:00:02.000Z');
    await expect(code(auth.consumeRecovery(deliveries[0] as string))).resolves.toBe('unauthorized');
    time.set('2026-10-04T00:02:00.000Z');
    await auth.requestRecovery(id);
    await auth.settled();
    time.set('2026-10-04T00:04:00.000Z');
    await auth.requestRecovery(id);
    await auth.settled();
    await expect(code(auth.consumeRecovery(deliveries[1] as string))).resolves.toBe('unauthorized');
    const consumed = await auth.consumeRecovery(deliveries[2] as string);
    expect(consumed).toMatchObject({ id, authorizationVersion: 2 });
    await expect(code(auth.consumeRecovery(deliveries[2] as string))).resolves.toBe('unauthorized');
  });

  it('consumeRecovery maps store races and vanished identities to errors', async () => {
    const request: RecoveryRequest = {
      id: 'r1',
      identityId: 'i1',
      tokenHash: '',
      issuedAt: new Date(T0),
      expiresAt: new Date('2027-01-01T00:00:00.000Z'),
      usedAt: null,
    };
    const tokens = { create: () => 'tok', hash: () => 'ab' };
    const build = (overrides: Partial<InMemoryIdentityStore>) => {
      const store = Object.assign(new InMemoryIdentityStore(), {
        findRecovery: async () => request,
        ...overrides,
      });
      return new IdentityService(store, notifier, tokens, clock().read);
    };
    await expect(
      code(build({ consumeRecovery: async () => false }).consumeRecovery('t')),
    ).resolves.toBe('conflict');
    const consumed = { consumeRecovery: async () => true };
    await expect(
      code(build({ ...consumed, findIdentity: async () => null }).consumeRecovery('t')),
    ).resolves.toBe('unauthorized');
    await expect(
      code(
        build({
          ...consumed,
          findIdentity: async () => identityOf('i1', 'revoked'),
        }).consumeRecovery('t'),
      ),
    ).resolves.toBe('unauthorized');
    let calls = 0;
    await expect(
      code(
        build({
          ...consumed,
          findIdentity: async () => (calls++ === 0 ? identityOf('i1', 'active') : null),
        }).consumeRecovery('t'),
      ),
    ).resolves.toBe('unauthorized');
  });
});
