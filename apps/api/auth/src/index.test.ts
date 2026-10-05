import { describe, expect, it } from 'vitest';
import { AuthApi } from './index.js';
import {
  IdentityService,
  InMemoryIdentityStore,
} from '../../../../packages/domain/identity/src/index.js';
import { verifyExternalPrincipal } from '../../../../packages/platform/auth/src/index.js';

const verifiedPrincipal = (subject: string) =>
  verifyExternalPrincipal(
    {
      verify: async (_code, issuer, nonce) => ({ issuer, subject, nonce }),
    },
    'synthetic-authorization-code',
    'https://issuer.example',
    'synthetic-nonce',
  );

describe('auth API trust boundaries', () => {
  it('derives active tenant and permissions from the server resolver', async () => {
    const service = new IdentityService(new InMemoryIdentityStore(), {
      deliver: async () => undefined,
    });
    const accessResolver = {
      resolveActiveTenant: async () => 'tenant-from-membership',
      resolvePermissions: async () => ['view'] as const,
    };
    const api = new AuthApi(service, accessResolver);

    const login = await api.login(await verifiedPrincipal('subject-1'));
    expect(login.ok).toBe(true);
    if (!login.value) throw new Error('login should return a session');
    await expect(service.authenticate(login.value.token, 'corr-1')).resolves.toMatchObject({
      tenantId: 'tenant-from-membership',
    });
    await expect(api.authorize(login.value.token, 'corr-2', 'view')).resolves.toEqual({
      ok: true,
      value: null,
    });
    await expect(api.authorize(login.value.token, 'corr-2', 'manage_users')).resolves.toMatchObject(
      {
        ok: false,
        error: { code: 'forbidden', message: 'Authentication request rejected' },
      },
    );
  });

  it('rejects a forged tenant and actor context before resolving permissions', async () => {
    let permissionLookups = 0;
    const service = new IdentityService(new InMemoryIdentityStore(), {
      deliver: async () => undefined,
    });
    const api = new AuthApi(service, {
      resolveActiveTenant: async () => 'tenant-a',
      resolvePermissions: async () => {
        permissionLookups += 1;
        return ['manage_users'];
      },
    });
    const forgedContext = {
      tenantId: 'tenant-admin',
      actor: { subject: 'forged-admin', kind: 'user' },
      authorizationVersion: 1,
      correlationId: 'forged-correlation',
    };

    await expect(
      api.authorize(forgedContext as unknown as string, 'corr-forged', 'manage_users'),
    ).resolves.toMatchObject({ ok: false, error: { code: 'unauthorized' } });
    expect(permissionLookups).toBe(0);
  });

  it('derives tenant and actor from the session and rejects cross-session scope mismatch', async () => {
    const service = new IdentityService(new InMemoryIdentityStore(), {
      deliver: async () => undefined,
    });
    const identityA = await service.linkExternal('oidc-test', 'session-a');
    const identityB = await service.linkExternal('oidc-test', 'session-b');
    const sessionA = await service.createSession(identityA.id, 'tenant-a');
    const sessionB = await service.createSession(identityB.id, 'tenant-b');
    const seenContexts: Array<{ tenantId: string; actorSubject: string }> = [];
    const api = new AuthApi(service, {
      resolveActiveTenant: async () => null,
      resolvePermissions: async (context) => {
        seenContexts.push({ tenantId: context.tenantId, actorSubject: context.actor.subject });
        return context.tenantId === 'tenant-b' && context.actor.subject === identityB.id
          ? ['manage_users']
          : [];
      },
    });

    await expect(api.authorize(sessionA.token, 'corr-a', 'manage_users')).resolves.toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });
    await expect(api.authorize(sessionB.token, 'corr-b', 'manage_users')).resolves.toEqual({
      ok: true,
      value: null,
    });
    expect(seenContexts).toEqual([
      { tenantId: 'tenant-a', actorSubject: identityA.id },
      { tenantId: 'tenant-b', actorSubject: identityB.id },
    ]);
  });

  it('denies login when trusted server state has no active membership', async () => {
    const service = new IdentityService(new InMemoryIdentityStore(), {
      deliver: async () => undefined,
    });
    const api = new AuthApi(service, {
      resolveActiveTenant: async () => null,
      resolvePermissions: async () => [],
    });

    await expect(api.login(await verifiedPrincipal('subject-2'))).resolves.toMatchObject({
      ok: false,
      error: { code: 'unauthorized', message: 'Authentication required' },
    });
  });

  it('fails closed when login receives unverified caller-supplied provider claims', async () => {
    let membershipLookups = 0;
    const service = new IdentityService(new InMemoryIdentityStore(), {
      deliver: async () => undefined,
    });
    const api = new AuthApi(service, {
      resolveActiveTenant: async () => {
        membershipLookups += 1;
        return 'tenant-a';
      },
      resolvePermissions: async () => ['view'],
    });

    await expect(
      api.login({ provider: 'attacker-controlled', subject: 'forged-subject' }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'unauthorized' } });
    expect(membershipLookups).toBe(0);
  });

  it('activates an invitation and new membership only with a verified external principal', async () => {
    const store = new InMemoryIdentityStore();
    const service = new IdentityService(store, { deliver: async () => undefined });
    const api = new AuthApi(service, {
      resolveActiveTenant: async () => 'tenant-a',
      resolvePermissions: async () => [],
    });
    const invitation = await service.issueInvitation('tenant-a');

    await expect(
      api.activateInvitation(invitation.token, { provider: 'forged', subject: 'forged' }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'unauthorized' } });
    const principal = await verifiedPrincipal('new-member-subject');
    const activated = await api.activateInvitation(invitation.token, principal);
    expect(activated).toMatchObject({
      ok: true,
      value: {
        identity: { id: invitation.identityId, status: 'active' },
        membership: {
          tenantId: 'tenant-a',
          identityId: invitation.identityId,
          status: 'active',
        },
      },
    });
    await expect(
      service.linkExternal(principal.provider, principal.subject),
    ).resolves.toMatchObject({ id: invitation.identityId });
    await expect(store.findMembership('tenant-a', invitation.identityId)).resolves.toMatchObject({
      status: 'active',
    });
  });
});
