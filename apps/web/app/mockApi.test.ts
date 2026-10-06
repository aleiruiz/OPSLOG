import { describe, expect, it } from 'vitest';
import { createFakeOidc, fakeOidcCode, fakeOidcSubject } from '../api/fakeOidc';
import { createMockApi, demoCredentials, demoInvitations } from './mockApi';

const identity = (subject: string) => ({ code: fakeOidcCode(subject), nonce: 'nonce-test' });

async function signedIn(account: keyof typeof demoCredentials = 'admin') {
  const api = createMockApi();
  await api.auth.login(demoCredentials[account]);
  return api;
}

describe('mock auth port', () => {
  it('rejects bad identities with a uniform 401 and accepts valid ones', async () => {
    const api = createMockApi();
    const unknown = await api.auth.login(identity('nadie'));
    const foreign = await api.auth.login({ code: 'otro-proveedor', nonce: 'n' });
    const noNonce = await api.auth.login({ ...demoCredentials.admin, nonce: '' });
    for (const result of [unknown, foreign, noNonce])
      expect(result).toMatchObject({ ok: false, error: { status: 401, code: 'unauthorized' } });
    expect(api.controls.isSignedIn()).toBe(false);
    const good = await api.auth.login(demoCredentials.admin);
    expect(good).toMatchObject({
      ok: true,
      value: { user: { id: 'user-admin' }, roleId: 'role-admin' },
    });
    expect(api.controls.isSignedIn()).toBe(true);
  });

  it('never carries names, emails or tokens in the session', async () => {
    const api = await signedIn();
    const session = await api.auth.getSession();
    expect(JSON.stringify(session)).not.toMatch(/displayName|email|csrf/i);
  });

  it('answers 401 after the session expires or the user logs out', async () => {
    const api = await signedIn();
    api.controls.expireSession();
    expect(await api.auth.getSession()).toMatchObject({ ok: false, error: { status: 401 } });
    await api.auth.login(demoCredentials.admin);
    await api.auth.logout();
    expect(await api.users.listUsers({})).toMatchObject({ ok: false, error: { status: 401 } });
  });

  it('injects a one-shot failure with the requested status', async () => {
    const api = await signedIn();
    api.controls.failNext('getSession');
    expect(await api.auth.getSession()).toMatchObject({ ok: false, error: { status: 500 } });
    expect((await api.auth.getSession()).ok).toBe(true);
    api.controls.failNext('login', 429);
    expect(await api.auth.login(demoCredentials.admin)).toMatchObject({ error: { status: 429 } });
    api.controls.failNext('logout');
    expect((await api.auth.logout()).ok).toBe(false);
    api.controls.failNext('inspectInvitation');
    expect((await api.auth.inspectInvitation(demoInvitations.valid)).ok).toBe(false);
    api.controls.failNext('acceptInvitation');
    expect((await api.auth.acceptInvitation(demoInvitations.valid, identity('x'))).ok).toBe(false);
  });

  it('treats unknown and expired invitations identically', async () => {
    const api = createMockApi();
    const unknown = await api.auth.inspectInvitation('desconocida');
    const expired = await api.auth.inspectInvitation(demoInvitations.expired);
    if (unknown.ok || expired.ok) throw new Error('expected both to fail');
    const shape = ({ code, status, message }: typeof unknown.error) => ({ code, status, message });
    expect(shape(unknown.error)).toEqual(shape(expired.error));
    const accept = await api.auth.acceptInvitation('desconocida', identity('x'));
    expect(accept).toMatchObject({ ok: false, error: { status: 404, code: 'not_found' } });
  });

  it('rejects login and session for users whose status is not active', async () => {
    const admin = await signedIn();
    await admin.users.deactivateUser('user-viewer', 'baja');
    await admin.auth.logout();
    expect(await admin.auth.login(demoCredentials.viewer)).toMatchObject({
      ok: false,
      error: { status: 401, code: 'unauthorized' },
    });
    expect(admin.controls.isSignedIn()).toBe(false);

    const api = await signedIn('viewer');
    expect((await api.auth.getSession()).ok).toBe(true);
    api.controls.setUserStatus('user-viewer', 'inactive');
    expect(await api.auth.getSession()).toMatchObject({
      ok: false,
      error: { status: 401, code: 'unauthorized' },
    });
    expect(api.controls.isSignedIn()).toBe(false);
    await api.auth.logout();
    expect((await api.auth.login(demoCredentials.viewer)).ok).toBe(false);
    api.controls.setUserStatus('user-viewer', 'active');
    expect((await api.auth.login(demoCredentials.viewer)).ok).toBe(true);
    api.controls.setUserStatus('nadie', 'active');
  });

  it('binds the accepted identity so the invitee can sign in again after signing out', async () => {
    const api = createMockApi();
    const accepted = await api.auth.acceptInvitation(demoInvitations.valid, identity('invitada'));
    expect(accepted).toMatchObject({
      ok: true,
      value: { roleId: 'role-fleet', user: { id: 'user-invitada' } },
    });
    await api.auth.logout();
    expect((await api.auth.login(identity('otra'))).ok).toBe(false);
    expect((await api.auth.login(identity('invitada'))).ok).toBe(true);
  });

  it('rejects a used invitation token and keeps the first account', async () => {
    const api = createMockApi();
    expect((await api.auth.acceptInvitation(demoInvitations.valid, identity('primera'))).ok).toBe(
      true,
    );
    await api.auth.logout();
    const replay = await api.auth.acceptInvitation(demoInvitations.valid, identity('segunda'));
    expect(replay).toMatchObject({ ok: false, error: { status: 404, code: 'not_found' } });
    expect(api.controls.isSignedIn()).toBe(false);
    expect((await api.auth.login(identity('segunda'))).ok).toBe(false);
    expect((await api.auth.login(identity('primera'))).ok).toBe(true);
  });

  it('does not replace an existing identity, and rejects an unverifiable code', async () => {
    const api = createMockApi();
    const taken = await api.auth.acceptInvitation(demoInvitations.valid, demoCredentials.admin);
    expect(taken).toMatchObject({ ok: false, error: { status: 404 } });
    const forged = await api.auth.acceptInvitation(demoInvitations.valid, {
      code: 'otro-proveedor',
      nonce: 'n',
    });
    expect(forged).toMatchObject({ ok: false, error: { status: 401 } });
    expect(api.controls.isSignedIn()).toBe(false);
  });

  it('activates the pending user of an invitation issued by an administrator', async () => {
    const api = await signedIn();
    const issued = await api.users.inviteUser({ roleId: 'role-viewer' });
    if (!issued.ok) throw new Error('expected ok');
    await api.auth.logout();
    expect(await api.auth.inspectInvitation(issued.value.invitationToken)).toMatchObject({
      ok: true,
      value: { companyName: 'Transportes Demo SA', roleLabel: 'Consulta' },
    });
    const accepted = await api.auth.acceptInvitation(
      issued.value.invitationToken,
      identity('nueva'),
    );
    expect(accepted).toMatchObject({ ok: true, value: { user: { id: issued.value.user.id } } });
    await api.auth.logout();
    await api.auth.login(demoCredentials.admin);
    const listed = await api.users.listUsers({ search: issued.value.user.id });
    expect(listed.ok && listed.value.items).toEqual([
      expect.objectContaining({ id: issued.value.user.id, status: 'active' }),
    ]);
  });
});

describe('mock tenant, users and roles ports', () => {
  it('denies configuration calls to a role without permission', async () => {
    const api = await signedIn('viewer');
    for (const result of [
      await api.tenant.getCompanySettings(),
      await api.users.listUsers({}),
      await api.roles.listRoles(),
    ])
      expect(result).toMatchObject({ ok: false, error: { status: 403 } });
  });

  it('validates and updates company settings, requiring a reason for security changes', async () => {
    const api = await signedIn();
    expect(
      await api.tenant.updateCompanySettings({ name: ' ', mfa: 'optional', sessionIdleHours: 99 }),
    ).toMatchObject({ error: { status: 400, code: 'bad_request' } });
    expect(
      await api.tenant.updateCompanySettings({
        name: 'Nueva',
        mfa: 'required',
        sessionIdleHours: 8,
      }),
    ).toMatchObject({ error: { status: 400, code: 'bad_request' } });
    const ok = await api.tenant.updateCompanySettings({
      name: ' Nueva ',
      mfa: 'required',
      sessionIdleHours: 4,
      reason: 'política',
    });
    expect(ok).toMatchObject({
      ok: true,
      value: { name: 'Nueva', mfa: 'required', sessionIdleHours: 4 },
    });
    const renamed = await api.tenant.updateCompanySettings({
      name: 'Solo nombre',
      mfa: 'required',
      sessionIdleHours: 4,
    });
    expect(renamed.ok).toBe(true);
  });

  it('paginates, sorts and filters users like the BFF', async () => {
    const api = await signedIn();
    const first = await api.users.listUsers({ limit: 25 });
    if (!first.ok) throw new Error('expected ok');
    expect(first.value.items).toHaveLength(25);
    expect(first.value.total).toBe(27);
    expect(first.value.sort).toEqual({ field: 'id', direction: 'asc' });
    expect(first.value.nextCursor).toBe('mock:25');
    const second = await api.users.listUsers({ limit: 25, cursor: 'mock:25' });
    if (!second.ok) throw new Error('expected ok');
    expect(second.value.items).toHaveLength(2);
    expect(second.value.nextCursor).toBeNull();
    const filtered = await api.users.listUsers({ search: ' ADMIN ' });
    if (!filtered.ok) throw new Error('expected ok');
    expect(filtered.value.items.map((user) => user.id)).toEqual(['user-admin']);
    const byStatus = await api.users.listUsers({ search: 'invited' });
    expect(byStatus.ok && byStatus.value.total).toBe(0);
    const descending = await api.users.listUsers({ sort: 'roleLabel', direction: 'desc' });
    expect(descending.ok && descending.value.sort).toEqual({
      field: 'roleLabel',
      direction: 'desc',
    });
    for (const query of [
      { cursor: 'forjado' },
      { sort: 'email' },
      { direction: 'up' },
      { limit: 10 },
      { search: 'x'.repeat(101) },
    ])
      expect(await api.users.listUsers(query as never)).toMatchObject({
        ok: false,
        error: { status: 400 },
      });
  });

  it('validates invitations: the role must exist, and the response carries the one-time token', async () => {
    const api = await signedIn();
    expect(await api.users.inviteUser({ roleId: 'inexistente' })).toMatchObject({
      error: { status: 400, code: 'bad_request' },
    });
    const ok = await api.users.inviteUser({ roleId: 'role-fleet' });
    expect(ok).toMatchObject({
      ok: true,
      value: { user: { status: 'invited', roleId: 'role-fleet' } },
    });
    expect(ok.ok && ok.value.invitationToken).toMatch(/^invitacion-emitida-/);
  });

  it('deactivates others with a reason but not unknown users, and keeps the last administrator', async () => {
    const api = await signedIn();
    expect(await api.users.deactivateUser('user-admin', 'x')).toMatchObject({
      error: { status: 409, code: 'last_admin' },
    });
    expect(await api.users.deactivateUser('nadie', 'x')).toMatchObject({ error: { status: 404 } });
    expect(await api.users.deactivateUser('user-dispatch', ' ')).toMatchObject({
      error: { status: 400 },
    });
    expect(await api.users.deactivateUser('user-dispatch', 'baja')).toEqual({
      ok: true,
      value: { id: 'user-dispatch', status: 'inactive' },
    });
  });

  it('lists the seven system templates and copies a role as custom', async () => {
    const api = await signedIn();
    const roles = await api.roles.listRoles();
    if (!roles.ok) throw new Error('expected ok');
    expect(roles.value.filter((role) => role.kind === 'system')).toHaveLength(7);
    expect(await api.roles.copyRole('nadie', 'x')).toMatchObject({ error: { status: 404 } });
    expect(await api.roles.copyRole('role-viewer', ' ')).toMatchObject({ error: { status: 400 } });
    expect(await api.roles.copyRole('role-viewer', 'consulta')).toMatchObject({
      error: { status: 409 },
    });
    const copy = await api.roles.copyRole('role-viewer', ' Auditor externo ');
    expect(copy).toMatchObject({
      ok: true,
      value: { kind: 'custom', name: 'Auditor externo', permissions: ['view'] },
    });
  });
});

describe('mock drafts port', () => {
  it('stores drafts per user and refuses them once the session expired', async () => {
    const api = await signedIn();
    await api.drafts.save('scope', { a: '1' });
    expect(api.controls.storedDrafts()).toEqual({ scope: { a: '1' } });
    expect(await api.drafts.load('scope')).toMatchObject({
      ok: true,
      value: { values: { a: '1' } },
    });
    api.controls.expireSession();
    expect(await api.drafts.save('scope', { a: '2' })).toMatchObject({ error: { status: 401 } });
    await api.auth.login(demoCredentials.viewer);
    expect(await api.drafts.load('scope')).toMatchObject({ ok: true, value: null });
    await api.auth.login(demoCredentials.admin);
    expect(api.controls.storedDrafts()).toEqual({ scope: { a: '1' } });
    await api.drafts.discard('scope');
    expect(api.controls.storedDrafts()).toEqual({});
  });
});

describe('fake identity provider', () => {
  it('issues a code for the typed account and a fresh nonce each time', async () => {
    const oidc = createFakeOidc();
    expect(oidc.hintLabel).toBe('Cuenta de prueba');
    const first = await oidc.authorize(' cuenta-admin ');
    const second = await oidc.authorize('cuenta-admin');
    if (!first.ok || !second.ok) throw new Error('expected ok');
    expect(fakeOidcSubject(first.value.code)).toBe('cuenta-admin');
    expect(first.value.nonce).not.toBe(second.value.nonce);
  });

  it('refuses an empty or oversized account and ignores foreign codes', async () => {
    const oidc = createFakeOidc();
    for (const hint of ['  ', 'x'.repeat(129)])
      expect(await oidc.authorize(hint)).toMatchObject({ ok: false, error: { status: 400 } });
    expect(fakeOidcSubject('otro')).toBeNull();
    expect(fakeOidcSubject('fake-code:')).toBeNull();
  });
});
