import { describe, expect, it } from 'vitest';
import { AuthApi } from './index.js';
import {
  IdentityService,
  InMemoryIdentityStore,
} from '../../../../packages/domain/identity/src/index.js';

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

    const login = await api.login('oidc-test', 'subject-1');
    expect(login.ok).toBe(true);
    if (!login.value) throw new Error('login should return a session');
    await expect(service.authenticate(login.value.token, 'corr-1')).resolves.toMatchObject({
      tenantId: 'tenant-from-membership',
    });
    const context = await service.authenticate(login.value.token, 'corr-2');
    await expect(api.authorize(context, 'view')).resolves.toEqual({ ok: true, value: null });
    await expect(api.authorize(context, 'manage_users')).resolves.toMatchObject({
      ok: false,
      error: { code: 'forbidden', message: 'Authentication request rejected' },
    });
  });

  it('denies login when trusted server state has no active membership', async () => {
    const service = new IdentityService(new InMemoryIdentityStore(), {
      deliver: async () => undefined,
    });
    const api = new AuthApi(service, {
      resolveActiveTenant: async () => null,
      resolvePermissions: async () => [],
    });

    await expect(api.login('oidc-test', 'subject-2')).resolves.toMatchObject({
      ok: false,
      error: { code: 'unauthorized', message: 'Authentication required' },
    });
  });
});
