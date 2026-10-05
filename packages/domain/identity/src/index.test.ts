import { describe, expect, it } from 'vitest';
import { AuthError, IdentityService, InMemoryIdentityStore } from './index.js';

const service = () => new IdentityService(new InMemoryIdentityStore());

describe('identity and authentication', () => {
  it('links an external subject stably without exposing provider tokens', async () => {
    const auth = service();
    const first = await auth.linkExternal('oidc-test', 'subject-1');
    const second = await auth.linkExternal('oidc-test', 'subject-1');
    expect(second.id).toBe(first.id);
  });

  it('consumes invitations once and rejects replay and expiry', async () => {
    let now = new Date('2026-10-04T00:00:00.000Z');
    const auth = new IdentityService(new InMemoryIdentityStore(), undefined, () => now);
    const identity = await auth.linkExternal('oidc-test', 'invitee');
    const invitation = await auth.issueInvitation('tenant-a', identity.id, 1_000);
    await expect(auth.activateInvitation(invitation.token)).resolves.toMatchObject({
      id: identity.id,
    });
    await expect(auth.activateInvitation(invitation.token)).rejects.toMatchObject({
      code: 'unauthorized',
    });
    const expired = await auth.issueInvitation('tenant-a', identity.id, 1_000);
    now = new Date('2026-10-04T00:00:02.000Z');
    await expect(auth.activateInvitation(expired.token)).rejects.toMatchObject({
      code: 'unauthorized',
    });
  });

  it('does not enumerate recovery identities', async () => {
    const auth = service();
    const result = await auth.requestRecovery('missing-identity');
    expect(result.accepted).toBe(true);
    await expect(auth.consumeRecovery(result.token)).rejects.toBeInstanceOf(AuthError);
  });

  it('rejects expired and revoked opaque sessions', async () => {
    let now = new Date('2026-10-04T00:00:00.000Z');
    const store = new InMemoryIdentityStore();
    const auth = new IdentityService(store, undefined, () => now);
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
      auth.activateInvitation(invitation.token),
      auth.activateInvitation(invitation.token),
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
