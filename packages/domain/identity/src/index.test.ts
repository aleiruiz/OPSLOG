import { describe, expect, it } from 'vitest';
import { IdentityService, InMemoryIdentityStore } from './index.js';

const deliveries: Array<{ identityId: string; token: string; expiresAt: Date }> = [];
const notifier = {
  deliver: async (identityId: string, token: string, expiresAt: Date) => {
    deliveries.push({ identityId, token, expiresAt });
  },
};
const service = () => new IdentityService(new InMemoryIdentityStore(), notifier);

describe('identity and authentication', () => {
  it('links an external subject stably without exposing provider tokens', async () => {
    const auth = service();
    const first = await auth.linkExternal('oidc-test', 'subject-1');
    const second = await auth.linkExternal('oidc-test', 'subject-1');
    expect(second.id).toBe(first.id);
  });

  it('atomically links concurrent attempts for an external subject to one identity', async () => {
    const auth = service();
    const linked = await Promise.all([
      auth.linkExternal('oidc-test', 'race-subject'),
      auth.linkExternal('oidc-test', 'race-subject'),
      auth.linkExternal('oidc-test', 'race-subject'),
    ]);
    expect(new Set(linked.map(({ id }) => id)).size).toBe(1);
  });

  it('consumes invitations once and rejects replay and expiry', async () => {
    let now = new Date('2026-10-04T00:00:00.000Z');
    const auth = new IdentityService(new InMemoryIdentityStore(), notifier, undefined, () => now);
    const identity = await auth.linkExternal('oidc-test', 'invitee');
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
    await expect(auth.linkExternal('oidc-test', 'new-invitee-subject')).resolves.toMatchObject({
      id: invitation.identityId,
    });
  });

  it('does not enumerate recovery identities', async () => {
    deliveries.length = 0;
    const auth = service();
    const result = await auth.requestRecovery('missing-identity');
    expect(result).toEqual({ accepted: true });
    expect(result).not.toHaveProperty('token');
    expect(deliveries).toHaveLength(0);
    const existing = await auth.linkExternal('oidc-test', 'recovery-user');
    const existingResult = await auth.requestRecovery(existing.id);
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
    const identity = await auth.linkExternal('oidc-test', 'session-user');
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
    const identity = await auth.linkExternal('oidc-test', 'concurrent-user');
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
    const identity = await auth.linkExternal('oidc-test', 'actor-user');
    const session = await auth.createSession(identity.id, 'tenant-a');
    const context = await auth.authenticate(session.token, 'corr-4');
    expect(Object.isFrozen(context)).toBe(true);
    await expect(auth.requirePermission(context, 'view', ['view'])).resolves.toBeUndefined();
    await expect(auth.requirePermission(context, 'manage_users', ['view'])).rejects.toMatchObject({
      code: 'forbidden',
    });
  });
});
