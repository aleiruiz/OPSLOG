import type { BffClient, BffRouteId } from '@opslog/contracts';
import { describe, expect, it } from 'vitest';
import type { Result } from '../app/types';
import { createFakeOidc } from './fakeOidc';
import { createHttpApi } from './ports';

const session = {
  company: { id: 'c', name: 'Empresa' },
  user: { id: 'u' },
  roleId: 'admin',
  roleLabel: 'Administrador',
  permissions: ['view'] as const,
  expiresAt: '2026-10-06T20:00:00.000Z',
  csrfToken: 'secret-token',
};
const failure = { ok: false, error: { code: 'x', status: 500, message: 'm', correlationId: 'c' } };

/** Records each call and answers with the scripted value for that route. */
function scripted(replies: Partial<Record<BffRouteId, unknown>>) {
  const calls: { id: string; input: unknown }[] = [];
  const client = {
    call: async (id: string, input?: unknown) => {
      calls.push({ id, input });
      return { ok: true, value: (replies as Record<string, unknown>)[id] };
    },
  } as unknown as BffClient;
  return { calls, api: createHttpApi(createFakeOidc(), {}, client) };
}

describe('createHttpApi', () => {
  it('hands the browser a session without the CSRF token', async () => {
    const { api, calls } = scripted({ 'auth.session': session, 'auth.login': session });
    const read = await api.auth.getSession();
    const login = await api.auth.login({ code: 'c', nonce: 'n' });
    for (const result of [read, login]) {
      expect(result.ok && Object.keys(result.value)).not.toContain('csrfToken');
      expect(result).toMatchObject({ ok: true, value: { user: { id: 'u' }, roleId: 'admin' } });
    }
    expect(calls[1]).toEqual({ id: 'auth.login', input: { body: { code: 'c', nonce: 'n' } } });
  });

  it('maps the invitation, settings, users, roles and drafts calls to routes', async () => {
    const { api, calls } = scripted({
      'auth.invitation.accept': session,
      'roles.list': { items: [{ id: 'viewer' }] },
      'drafts.load': { draft: { scope: 's', values: {}, savedAt: 'x' } },
    });
    await api.auth.inspectInvitation('tok');
    expect(await api.auth.acceptInvitation('tok', { code: 'c', nonce: 'n' })).toMatchObject({
      ok: true,
      value: { roleLabel: 'Administrador' },
    });
    await api.tenant.getCompanySettings();
    await api.tenant.updateCompanySettings({ name: 'n', mfa: 'optional', sessionIdleHours: 8 });
    await api.tenant.updateCompanySettings({
      name: 'n',
      mfa: 'optional',
      sessionIdleHours: 8,
      reason: 'r',
    });
    await api.users.listUsers({ limit: 25, search: '' });
    await api.users.listUsers({ limit: 50, search: 'x', cursor: 'c' });
    await api.users.inviteUser({ roleId: 'viewer' });
    await api.users.deactivateUser('u1', 'baja');
    expect(await api.roles.listRoles()).toEqual({ ok: true, value: [{ id: 'viewer' }] });
    await api.roles.copyRole('viewer', 'Copia');
    expect(await api.drafts.load('s')).toMatchObject({ ok: true, value: { scope: 's' } });
    await api.drafts.save('s', { a: 'b' });
    expect(await api.drafts.discard('s')).toEqual({ ok: true, value: null });
    await api.auth.logout();
    expect(calls.map((call) => call.id)).toEqual([
      'auth.invitation.inspect',
      'auth.invitation.accept',
      'company.settings.get',
      'company.settings.update',
      'company.settings.update',
      'users.list',
      'users.list',
      'users.invite',
      'users.deactivate',
      'roles.list',
      'roles.copy',
      'drafts.load',
      'drafts.save',
      'drafts.discard',
      'auth.logout',
    ]);
    expect(calls[3]?.input).toEqual({
      body: { name: 'n', mfa: 'optional', sessionIdleHours: 8 },
    });
    expect(calls[4]?.input).toMatchObject({ body: { reason: 'r' } });
    expect(calls[5]?.input).toEqual({ query: { limit: 25 } });
    expect(calls[6]?.input).toEqual({ query: { limit: 50, cursor: 'c', search: 'x' } });
    expect(calls[8]?.input).toEqual({ params: { id: 'u1' }, body: { reason: 'baja' } });
    expect(calls[11]?.input).toEqual({ params: { scope: 's' } });
  });

  it('passes failures through untouched and exposes the identity provider', async () => {
    const oidc = createFakeOidc();
    const client = { call: async () => failure } as unknown as BffClient;
    const api = createHttpApi(oidc, {}, client);
    const results: Result<unknown>[] = [
      await api.auth.getSession(),
      await api.auth.logout(),
      await api.roles.listRoles(),
      await api.drafts.load('s'),
      await api.drafts.discard('s'),
    ];
    for (const result of results) expect(result).toEqual(failure);
    expect(api.oidc).toBe(oidc);
  });

  it('builds its own client from the options when none is given', async () => {
    const api = createHttpApi(createFakeOidc(), {
      fetch: async () => ({ status: 500, headers: { get: () => null }, text: async () => '' }),
    });
    expect(await api.auth.getSession()).toMatchObject({ ok: false });
  });
});
