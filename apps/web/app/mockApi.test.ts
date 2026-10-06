import { describe, expect, it } from 'vitest';
import { createMockApi, demoCredentials, demoInvitations } from './mockApi';

async function signedIn(account: keyof typeof demoCredentials = 'admin') {
  const api = createMockApi();
  await api.auth.login(demoCredentials[account]);
  return api;
}

describe('mock auth port', () => {
  it('rejects bad credentials with a uniform 401 and accepts valid ones', async () => {
    const api = createMockApi();
    const bad = await api.auth.login({ email: demoCredentials.admin.email, password: 'x' });
    const unknown = await api.auth.login({ email: 'nadie@demo.opslog.test', password: 'x' });
    expect(bad).toMatchObject({ ok: false, error: { status: 401, code: 'invalid_credentials' } });
    expect(unknown).toEqual(
      expect.objectContaining({ ok: false, error: expect.objectContaining({ status: 401 }) }),
    );
    expect(api.controls.isSignedIn()).toBe(false);
    const good = await api.auth.login({
      email: ` ${demoCredentials.admin.email.toUpperCase()} `,
      password: demoCredentials.admin.password,
    });
    expect(good.ok).toBe(true);
    expect(api.controls.isSignedIn()).toBe(true);
  });

  it('never exposes a token field in session responses', async () => {
    const api = await signedIn();
    const session = await api.auth.getSession();
    expect(session.ok).toBe(true);
    expect(JSON.stringify(session)).not.toMatch(/token|cookie|secret/i);
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
    expect(
      (await api.auth.acceptInvitation(demoInvitations.valid, { displayName: 'a', password: 'b' }))
        .ok,
    ).toBe(false);
  });

  it('treats unknown and expired invitations identically', async () => {
    const api = createMockApi();
    const unknown = await api.auth.inspectInvitation('desconocida');
    const expired = await api.auth.inspectInvitation(demoInvitations.expired);
    if (unknown.ok || expired.ok) throw new Error('expected both to fail');
    const shape = ({ code, status, message }: typeof unknown.error) => ({ code, status, message });
    expect(shape(unknown.error)).toEqual(shape(expired.error));
    const accept = await api.auth.acceptInvitation('desconocida', {
      displayName: 'x',
      password: 'y'.repeat(12),
    });
    expect(accept).toMatchObject({
      ok: false,
      error: { status: 404, code: 'invitation_unavailable' },
    });
  });

  it('rejects login and session for users whose status is not active', async () => {
    const admin = await signedIn();
    await admin.users.deactivateUser('user-viewer', 'baja');
    await admin.auth.logout();
    expect(await admin.auth.login(demoCredentials.viewer)).toMatchObject({
      ok: false,
      error: { status: 401, code: 'invalid_credentials' },
    });
    expect(admin.controls.isSignedIn()).toBe(false);

    const api = await signedIn('viewer');
    expect((await api.auth.getSession()).ok).toBe(true);
    api.controls.setUserStatus('user-viewer', 'inactive');
    expect(await api.auth.getSession()).toMatchObject({
      ok: false,
      error: { status: 401, code: 'session_expired' },
    });
    await api.auth.logout();
    expect((await api.auth.login(demoCredentials.viewer)).ok).toBe(false);
    api.controls.setUserStatus('user-viewer', 'active');
    expect((await api.auth.login(demoCredentials.viewer)).ok).toBe(true);
    api.controls.setUserStatus('nadie', 'active');
  });

  it('stores the accepted password so the invitee can log in after signing out', async () => {
    const api = createMockApi();
    const password = 'contrasena-de-invitada-1';
    expect(
      (await api.auth.acceptInvitation(demoInvitations.valid, { displayName: 'Ana', password })).ok,
    ).toBe(true);
    await api.auth.logout();
    expect(
      await api.auth.login({ email: 'invitada@demo.opslog.test', password: 'otra-contrasena-12' }),
    ).toMatchObject({ ok: false, error: { status: 401 } });
    expect((await api.auth.login({ email: 'invitada@demo.opslog.test', password })).ok).toBe(true);
  });

  it('rejects a used invitation token and keeps the first account and password', async () => {
    const api = createMockApi();
    const first = 'primera-contrasena-1';
    const weak = await api.auth.acceptInvitation(demoInvitations.valid, {
      displayName: 'Ana',
      password: 'corta',
    });
    expect(weak.ok).toBe(false);
    expect(
      (
        await api.auth.acceptInvitation(demoInvitations.valid, {
          displayName: 'Ana',
          password: first,
        })
      ).ok,
    ).toBe(true);
    await api.auth.logout();
    const replay = await api.auth.acceptInvitation(demoInvitations.valid, {
      displayName: 'Intruso',
      password: 'segunda-contrasena-2',
    });
    expect(replay).toMatchObject({
      ok: false,
      error: { status: 404, code: 'invitation_unavailable' },
    });
    expect(api.controls.isSignedIn()).toBe(false);
    expect(
      (
        await api.auth.login({
          email: 'invitada@demo.opslog.test',
          password: 'segunda-contrasena-2',
        })
      ).ok,
    ).toBe(false);
    expect((await api.auth.login({ email: 'invitada@demo.opslog.test', password: first })).ok).toBe(
      true,
    );
    await api.auth.logout();
    await api.auth.login(demoCredentials.admin);
    const listed = await api.users.listUsers({ search: 'invitada' });
    expect(listed.ok && listed.value.items).toHaveLength(1);
  });

  it('does not replace an existing account with the same email', async () => {
    const api = await signedIn();
    await api.users.inviteUser({ email: 'invitada@demo.opslog.test', roleId: 'role-viewer' });
    await api.auth.logout();
    const result = await api.auth.acceptInvitation(demoInvitations.valid, {
      displayName: 'Ana',
      password: 'primera-contrasena-1',
    });
    expect(result.ok).toBe(false);
  });

  it('enforces the 12 character minimum when accepting an invitation', async () => {
    const api = createMockApi();
    const weak = await api.auth.acceptInvitation(demoInvitations.valid, {
      displayName: 'Ana',
      password: 'x'.repeat(5),
    });
    expect(weak).toMatchObject({
      ok: false,
      error: { status: 422, fieldErrors: [{ field: 'password' }] },
    });
    const strong = await api.auth.acceptInvitation(demoInvitations.valid, {
      displayName: 'Ana',
      password: 'z'.repeat(14),
    });
    expect(strong.ok).toBe(true);
    expect(api.controls.isSignedIn()).toBe(true);
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
    ).toMatchObject({
      error: { status: 400, fieldErrors: [{ field: 'name' }, { field: 'sessionIdleHours' }] },
    });
    expect(
      await api.tenant.updateCompanySettings({
        name: 'Nueva',
        mfa: 'required',
        sessionIdleHours: 8,
      }),
    ).toMatchObject({
      error: { status: 422, code: 'reason_required' },
    });
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

  it('paginates and filters users', async () => {
    const api = await signedIn();
    const first = await api.users.listUsers({ limit: 25 });
    if (!first.ok) throw new Error('expected ok');
    expect(first.value.items).toHaveLength(25);
    expect(first.value.total).toBe(27);
    expect(first.value.nextCursor).toBe('25');
    const second = await api.users.listUsers({ limit: 25, cursor: '25' });
    if (!second.ok) throw new Error('expected ok');
    expect(second.value.items).toHaveLength(2);
    expect(second.value.nextCursor).toBeNull();
    const filtered = await api.users.listUsers({ search: ' PRUEBA ' });
    if (!filtered.ok) throw new Error('expected ok');
    expect(filtered.value.items.map((user) => user.displayName)).toEqual(['Ana Prueba']);
  });

  it('validates invitations: email, role and duplicates', async () => {
    const api = await signedIn();
    expect(await api.users.inviteUser({ email: 'mal', roleId: 'role-fleet' })).toMatchObject({
      error: { fieldErrors: [{ field: 'email' }] },
    });
    expect(
      await api.users.inviteUser({ email: 'a@demo.opslog.test', roleId: 'inexistente' }),
    ).toMatchObject({ error: { fieldErrors: [{ field: 'roleId' }] } });
    expect(
      await api.users.inviteUser({ email: demoCredentials.admin.email, roleId: 'role-fleet' }),
    ).toMatchObject({ error: { status: 409 } });
    const ok = await api.users.inviteUser({
      email: 'Nueva@Demo.Opslog.Test',
      roleId: 'role-fleet',
    });
    expect(ok).toMatchObject({
      ok: true,
      value: { status: 'invited', email: 'nueva@demo.opslog.test' },
    });
  });

  it('deactivates others with a reason but not yourself or unknown users', async () => {
    const api = await signedIn();
    expect(await api.users.deactivateUser('user-admin', 'x')).toMatchObject({
      error: { status: 422 },
    });
    expect(await api.users.deactivateUser('nadie', 'x')).toMatchObject({ error: { status: 404 } });
    expect(await api.users.deactivateUser('user-dispatch', ' ')).toMatchObject({
      error: { status: 400 },
    });
    expect(await api.users.deactivateUser('user-dispatch', 'baja')).toMatchObject({
      ok: true,
      value: { status: 'inactive' },
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
