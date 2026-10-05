import { describe, expect, it } from 'vitest';
import { IdentityService, InMemoryIdentityStore } from './index.js';

const deliveries: Array<{ identityId: string; token: string; expiresAt: Date }> = [];
const notifier = {
  deliver: async (identityId: string, token: string, expiresAt: Date) => {
    deliveries.push({ identityId, token, expiresAt });
  },
};
const service = () => new IdentityService(new InMemoryIdentityStore(), notifier);

const enroll = async (auth: IdentityService, tenantId: string, subject: string) => {
  const invitation = await auth.issueInvitation(tenantId);
  await auth.activateInvitation(invitation.token, 'oidc-test', subject);
  return invitation.identityId;
};
const clock = (start = '2026-10-04T00:00:00.000Z') => {
  let now = new Date(start);
  return { read: () => now, set: (value: string) => void (now = new Date(value)) };
};

describe('identity and authentication', () => {
  it('links an external subject stably without exposing provider tokens', async () => {
    const auth = service();
    const first = await auth.provisionExternal('oidc-test', 'subject-1');
    const second = await auth.provisionExternal('oidc-test', 'subject-1');
    expect(second.id).toBe(first.id);
  });

  it('atomically links concurrent attempts for an external subject to one identity', async () => {
    const auth = service();
    const linked = await Promise.all([
      auth.provisionExternal('oidc-test', 'race-subject'),
      auth.provisionExternal('oidc-test', 'race-subject'),
      auth.provisionExternal('oidc-test', 'race-subject'),
    ]);
    expect(new Set(linked.map(({ id }) => id)).size).toBe(1);
  });

  it('consumes invitations once and rejects replay and expiry', async () => {
    let now = new Date('2026-10-04T00:00:00.000Z');
    const auth = new IdentityService(new InMemoryIdentityStore(), notifier, undefined, () => now);
    const identity = await auth.provisionExternal('oidc-test', 'invitee');
    const invitation = await auth.issueInvitation('tenant-a', identity.id, 1_000);
    await expect(
      auth.activateInvitation(invitation.token, 'oidc-test', 'invitee'),
    ).resolves.toMatchObject({
      identity: { id: identity.id, status: 'active' },
      membership: { tenantId: 'tenant-a', status: 'active' },
    });
    await expect(
      auth.activateInvitation(invitation.token, 'oidc-test', 'invitee'),
    ).rejects.toMatchObject({
      code: 'unauthorized',
    });
    const expired = await auth.issueInvitation('tenant-a', undefined, 1_000);
    now = new Date('2026-10-04T00:00:02.000Z');
    await expect(
      auth.activateInvitation(expired.token, 'oidc-test', 'invitee'),
    ).rejects.toMatchObject({
      code: 'unauthorized',
    });
  });

  it('creates a pending identity and membership, then activates both from an invitation', async () => {
    const store = new InMemoryIdentityStore();
    const auth = new IdentityService(store, notifier);
    const invitation = await auth.issueInvitation('tenant-new');
    expect(await store.findIdentity(invitation.identityId)).toMatchObject({ status: 'pending' });
    expect(await store.findMembership('tenant-new', invitation.identityId)).toMatchObject({
      status: 'pending',
    });

    const result = await auth.activateInvitation(
      invitation.token,
      'oidc-test',
      'new-invitee-subject',
    );
    expect(result).toMatchObject({
      identity: { id: invitation.identityId, status: 'active' },
      membership: {
        tenantId: 'tenant-new',
        identityId: invitation.identityId,
        status: 'active',
      },
    });
    await expect(auth.resolveExternal('oidc-test', 'new-invitee-subject')).resolves.toMatchObject({
      id: invitation.identityId,
    });
  });

  it('does not enumerate recovery identities', async () => {
    deliveries.length = 0;
    const auth = service();
    const result = await auth.requestRecovery('missing-identity');
    await auth.settled();
    expect(result).toEqual({ accepted: true });
    expect(result).not.toHaveProperty('token');
    expect(deliveries).toHaveLength(0);
    const existing = await auth.provisionExternal('oidc-test', 'recovery-user');
    const existingResult = await auth.requestRecovery(existing.id);
    await auth.settled();
    expect(existingResult).toEqual(result);
    expect(existingResult).not.toHaveProperty('token');
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.identityId).toBe(existing.id);
    await expect(auth.consumeRecovery(deliveries[0]!.token)).resolves.toMatchObject({
      id: existing.id,
    });
  });

  it('rejects expired and revoked opaque sessions', async () => {
    let now = new Date('2026-10-04T00:00:00.000Z');
    const store = new InMemoryIdentityStore();
    const auth = new IdentityService(store, notifier, undefined, () => now);
    const identity = { id: await enroll(auth, 'tenant-a', 'session-user') };
    const session = await auth.createSession(identity.id, 'tenant-a', 1000);
    await expect(auth.authenticate(session.token, 'corr-1')).resolves.toMatchObject({
      tenantId: 'tenant-a',
    });
    now = new Date('2026-10-04T00:00:02.000Z');
    await expect(auth.authenticate(session.token, 'corr-2')).rejects.toMatchObject({
      code: 'unauthorized',
    });
    const fresh = await auth.createSession(identity.id, 'tenant-a');
    await auth.revoke(fresh.token);
    await expect(auth.authenticate(fresh.token, 'corr-3')).rejects.toMatchObject({
      code: 'unauthorized',
    });
  });

  it('allows exactly one concurrent invitation activation', async () => {
    const auth = service();
    const identity = await auth.provisionExternal('oidc-test', 'concurrent-user');
    const invitation = await auth.issueInvitation('tenant-a', identity.id);
    const results = await Promise.allSettled([
      auth.activateInvitation(invitation.token, 'oidc-test', 'concurrent-user'),
      auth.activateInvitation(invitation.token, 'oidc-test', 'concurrent-user'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it('returns an immutable tenant actor context and enforces permissions', async () => {
    const auth = service();
    const identity = { id: await enroll(auth, 'tenant-a', 'actor-user') };
    const session = await auth.createSession(identity.id, 'tenant-a');
    const context = await auth.authenticate(session.token, 'corr-4');
    expect(Object.isFrozen(context)).toBe(true);
    await expect(auth.requirePermission(context, 'view', ['view'])).resolves.toBeUndefined();
    await expect(auth.requirePermission(context, 'manage_users', ['view'])).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('rejects an invitation token presented by a different subject than the identity link', async () => {
    const auth = service();
    const victim = await auth.provisionExternal('oidc-test', 'victim-subject');
    const invitation = await auth.issueInvitation('tenant-b', victim.id);
    await expect(
      auth.activateInvitation(invitation.token, 'oidc-test', 'attacker-subject'),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(auth.resolveExternal('oidc-test', 'attacker-subject')).rejects.toMatchObject({
      code: 'unauthorized',
    });
    // The legitimate subject can still use the untouched invitation.
    await expect(
      auth.activateInvitation(invitation.token, 'oidc-test', 'victim-subject'),
    ).resolves.toMatchObject({ identity: { id: victim.id } });
  });

  it('denies sessions once the membership is revoked or the identity version is bumped', async () => {
    const store = new InMemoryIdentityStore();
    const auth = new IdentityService(store, notifier);
    const identityId = await enroll(auth, 'tenant-a', 'revoked-user');
    const other = await enroll(auth, 'tenant-a', 'bystander');
    const session = await auth.createSession(identityId, 'tenant-a');
    const bystander = await auth.createSession(other, 'tenant-a');
    await expect(auth.authenticate(session.token, 'corr')).resolves.toMatchObject({
      tenantId: 'tenant-a',
    });
    await auth.revokeMembership('tenant-a', identityId);
    await expect(auth.authenticate(session.token, 'corr')).rejects.toMatchObject({
      code: 'unauthorized',
    });
    await expect(auth.authenticate(bystander.token, 'corr')).resolves.toMatchObject({
      tenantId: 'tenant-a',
    });
    await expect(auth.revokeMembership('tenant-a', identityId)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('rejects recovery replay, expiry and a superseded token, and revokes sessions on success', async () => {
    deliveries.length = 0;
    const time = clock();
    const auth = new IdentityService(new InMemoryIdentityStore(), notifier, undefined, time.read);
    const identityId = await enroll(auth, 'tenant-a', 'recovering-user');
    const session = await auth.createSession(identityId, 'tenant-a');

    await auth.requestRecovery(identityId, 1_000);
    await auth.settled();
    await auth.requestRecovery(identityId, 60_000);
    await auth.settled();
    const [stale, current] = deliveries;
    await expect(auth.consumeRecovery(stale!.token)).rejects.toMatchObject({
      code: 'unauthorized',
    });
    await expect(auth.consumeRecovery(current!.token)).resolves.toMatchObject({ id: identityId });
    await expect(auth.consumeRecovery(current!.token)).rejects.toMatchObject({
      code: 'unauthorized',
    });
    await expect(auth.authenticate(session.token, 'corr')).rejects.toMatchObject({
      code: 'unauthorized',
    });

    deliveries.length = 0;
    await auth.requestRecovery(identityId, 1_000);
    await auth.settled();
    time.set('2026-10-04T00:00:02.000Z');
    await expect(auth.consumeRecovery(deliveries[0]!.token)).rejects.toMatchObject({
      code: 'unauthorized',
    });
  });

  it('allows exactly one concurrent recovery consumption', async () => {
    deliveries.length = 0;
    const auth = service();
    const identityId = await enroll(auth, 'tenant-a', 'racing-user');
    await auth.requestRecovery(identityId);
    await auth.settled();
    const results = await Promise.allSettled([
      auth.consumeRecovery(deliveries[0]!.token),
      auth.consumeRecovery(deliveries[0]!.token),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  });

  it('answers recovery requests without waiting for the account lookup or delivery', async () => {
    let delivered = false;
    const slow = {
      deliver: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        delivered = true;
      },
    };
    const auth = new IdentityService(new InMemoryIdentityStore(), slow);
    const identityId = await enroll(auth, 'tenant-a', 'slow-delivery-user');
    await expect(auth.requestRecovery(identityId)).resolves.toEqual({ accepted: true });
    expect(delivered).toBe(false);
    await auth.settled();
    expect(delivered).toBe(true);
  });

  it('rejects revoke input that is not a token', async () => {
    await expect(service().revoke(undefined as unknown as string)).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });
});
