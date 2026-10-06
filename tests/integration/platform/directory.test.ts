import { afterEach, describe, expect, it } from 'vitest';
import {
  DraftStore,
  MAX_DRAFTS_PER_ACTOR,
  RoleCatalog,
  TenantSettingsStore,
} from '../../../apps/api/composition/src/index.js';
import { corr, createWorld, type World } from './world.js';

let world: World;
afterEach(() => world?.dispose());

const HOUR = 3_600_000;

async function fixture() {
  world = createWorld();
  const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
  const viewer = await world.member(a.admin, 'viewer', 'subject-viewer-a');
  const b = await world.tenant('Empresa Beta', 'subject-admin-b');
  return { a, b, viewer };
}

describe('role, settings and draft directories', () => {
  it('finds roles of one tenant only and keeps names unique', () => {
    const catalog = new RoleCatalog();
    catalog.add('t-a', { id: 'custom-1', name: 'Regional', permissions: ['view'] });
    expect(catalog.find('t-a', 'custom-1')?.name).toBe('Regional');
    expect(catalog.find('t-b', 'custom-1')).toBeUndefined();
    expect(catalog.find('t-a', 'viewer')?.permissions).toEqual(['view']);
    expect(catalog.find('t-a', 'toString')).toBeUndefined();
    expect(catalog.find('t-a', '__proto__')).toBeUndefined();
    expect(catalog.custom('t-b')).toEqual([]);
    expect(catalog.nameTaken('t-a', ' regional ')).toBe(true);
    expect(catalog.nameTaken('t-b', 'regional')).toBe(false);
    expect(catalog.nameTaken('t-b', 'ADMINISTRADOR')).toBe(true);
    catalog.add('t-a', { id: 'custom-2', name: 'Otra', permissions: [] });
    expect(catalog.custom('t-a')).toHaveLength(2);
  });

  it('stores drafts per tenant and person with a cap', () => {
    const store = new DraftStore();
    const record = (scope: string) => ({ scope, values: {}, savedAt: new Date(0) });
    expect(store.load('t', 'u', 's')).toBeNull();
    expect(store.save('t', 'u', record('s'))).toBe(true);
    expect(store.load('t', 'u', 's')?.scope).toBe('s');
    expect(store.load('t', 'other', 's')).toBeNull();
    expect(store.load('other', 'u', 's')).toBeNull();
    // Keys cannot collide across tenant/person boundaries.
    store.save('t1', 'u', record('x'));
    expect(store.load('t', '1u', 'x')).toBeNull();
    for (let index = 0; index < MAX_DRAFTS_PER_ACTOR - 1; index += 1)
      store.save('t', 'u', record(`scope-${index}`));
    expect(store.save('t', 'u', record('one-too-many'))).toBe(false);
    expect(store.save('t', 'u', record('scope-1'))).toBe(true);
    store.discard('t', 'u', 'scope-1');
    store.discard('t', 'nobody', 'scope-1');
    expect(store.load('t', 'u', 'scope-1')).toBeNull();
    expect(store.save('t', 'u', record('one-too-many'))).toBe(true);
  });

  it('defaults settings per tenant', () => {
    const store = new TenantSettingsStore();
    expect(store.get('t', 'Nombre')).toEqual({
      name: 'Nombre',
      mfa: 'disabled',
      sessionIdleHours: 8,
    });
    store.set('t', { name: 'Otro', mfa: 'required', sessionIdleHours: 4 });
    expect(store.get('t', 'Nombre').name).toBe('Otro');
    expect(store.get('u', 'Nombre').name).toBe('Nombre');
  });
});

describe('platform operations behind the BFF', () => {
  it('describes a session and fails closed when the role or the mirror is gone', async () => {
    const { a, viewer } = await fixture();
    const details = await world.platform.sessionDetails(a.admin.token, corr());
    expect(details.value).toMatchObject({
      tenantId: a.tenantId,
      companyName: 'Empresa Alfa',
      roleId: 'admin',
      roleLabel: 'Administrador',
    });
    expect(details.value?.permissions).toContain('manage_config');
    expect(details.value?.expiresAt.getTime()).toBe(Date.now() + 8 * HOUR);
    // Identity and control plane still accept the session, but the role directory no longer lists the member.
    world.platform.access.revoke(a.tenantId, viewer.identityId);
    const orphan = await world.platform.sessionDetails(viewer.token, corr());
    expect(orphan.ok).toBe(false);
    expect(orphan.error?.code).toBe('unauthorized');
    for (const token of ['', 'nope', 5 as unknown as string])
      expect((await world.platform.sessionDetails(token, corr())).ok).toBe(false);
  });

  it('inspects invitations without consuming them and hides every failure', async () => {
    const { a, b } = await fixture();
    const invite = await world.platform.inviteUser(a.admin.token, corr(), 'auditor');
    const token = invite.value!.invitationToken;
    for (let index = 0; index < 2; index += 1)
      expect((await world.platform.inspectInvitation(token)).value).toEqual({
        companyName: 'Empresa Alfa',
        roleLabel: 'Auditoría',
      });
    for (const bad of ['', 'x'.repeat(513), 'unknown', 5 as unknown as string]) {
      const result = await world.platform.inspectInvitation(bad);
      expect(result.error).toMatchObject({ code: 'not_found', status: 404 });
    }
    await world.platform.suspendTenant(a.tenantId);
    expect((await world.platform.inspectInvitation(token)).error?.code).toBe('not_found');
    await world.platform.reactivateTenant(a.tenantId);
    expect((await world.platform.inspectInvitation(token)).ok).toBe(true);
    // Accepting consumes it: afterwards it cannot be inspected.
    const accepted = await world.platform.acceptInvitation(
      token,
      await world.principal('subject-new'),
    );
    expect(accepted.ok).toBe(true);
    expect((await world.platform.inspectInvitation(token)).error?.code).toBe('not_found');
    // An expired invitation is forgotten on first inspection and keeps answering not found.
    const old = (await world.platform.inviteUser(a.admin.token, corr(), 'viewer')).value!;
    world.advance(73 * HOUR);
    expect((await world.platform.inspectInvitation(old.invitationToken)).error?.code).toBe(
      'not_found',
    );
    expect((await world.platform.inspectInvitation(old.invitationToken)).error?.code).toBe(
      'not_found',
    );
    expect(b.tenantId).not.toBe(a.tenantId);
  });

  it('does not keep accepted or expired invitations in the registry', async () => {
    const { a } = await fixture();
    const registry = () =>
      (world.platform as unknown as { invitations: Map<string, unknown> }).invitations.size;
    const first = (await world.platform.inviteUser(a.admin.token, corr(), 'viewer')).value!;
    const second = (await world.platform.inviteUser(a.admin.token, corr(), 'viewer')).value!;
    expect(registry()).toBe(2);
    const accepted = await world.platform.acceptInvitation(
      first.invitationToken,
      await world.principal('subject-accepts'),
    );
    expect(accepted.ok).toBe(true);
    expect(registry()).toBe(1);
    // The remaining one expires; the next invitation prunes it.
    world.advance(73 * HOUR);
    const admin = await world.signIn('subject-admin-a', a.tenantId);
    await world.platform.inviteUser(admin.token, corr(), 'viewer');
    expect(registry()).toBe(1);
    expect((await world.platform.inspectInvitation(second.invitationToken)).error?.code).toBe(
      'not_found',
    );
    // A failed acceptance keeps the invitation usable.
    const third = (await world.platform.inviteUser(admin.token, corr(), 'viewer')).value!;
    expect((await world.platform.acceptInvitation(third.invitationToken, 'forged')).ok).toBe(false);
    expect((await world.platform.inspectInvitation(third.invitationToken)).ok).toBe(true);
  });

  it('lists members with their statuses and roles with member counts', async () => {
    const { a, b, viewer } = await fixture();
    await world.platform.inviteUser(a.admin.token, corr(), 'editor');
    await world.platform.removeMember(a.admin.token, corr(), viewer.identityId);
    const members = await world.platform.listMembers(a.admin.token, corr());
    expect(members.value?.tenantId).toBe(a.tenantId);
    expect(members.value?.members.map((m) => m.status).sort()).toEqual([
      'active',
      'inactive',
      'invited',
    ]);
    const foreign = await world.platform.listMembers(b.admin.token, corr());
    expect(foreign.value?.members).toHaveLength(1);
    const roles = await world.platform.listRoles(a.admin.token, corr());
    expect(roles.value?.find((r) => r.id === 'admin')?.memberCount).toBe(1);
    expect(roles.value?.find((r) => r.id === 'viewer')?.memberCount).toBe(0);
    for (const call of [
      world.platform.listMembers('bad', corr()),
      world.platform.listRoles('bad', corr()),
      world.platform.getSettings('bad', corr()),
      world.platform.copyRole('bad', corr(), 'viewer', 'x'),
    ])
      expect((await call).error?.code).toBe('unauthorized');
  });

  it('copies roles with strict validation of both arguments', async () => {
    const { a, viewer } = await fixture();
    const { token } = a.admin;
    const code = async (roleId: unknown, name: unknown) =>
      (await world.platform.copyRole(token, corr(), roleId as string, name)).error?.code;
    expect(await code(5, 'x')).toBe('not_found');
    expect(await code('missing', 'x')).toBe('not_found');
    expect(await code('viewer', 5)).toBe('invalid_input');
    expect(await code('viewer', '   ')).toBe('invalid_input');
    expect(await code('viewer', 'x'.repeat(81))).toBe('invalid_input');
    expect(await code('viewer', 'Consulta')).toBe('conflict');
    expect(await code('viewer', 'Nueva')).toBeUndefined();
    expect(await code('viewer', 'nueva')).toBe('conflict');
    const asViewer = await world.platform.copyRole(viewer.token, corr(), 'viewer', 'Otra');
    expect(asViewer.error?.code).toBe('forbidden');
  });

  it('validates settings strictly and audits security changes', async () => {
    const { a, viewer } = await fixture();
    const { token } = a.admin;
    const base = { name: 'Empresa Alfa', mfa: 'disabled', sessionIdleHours: 8 };
    const code = async (input: Record<string, unknown>) =>
      (await world.platform.updateSettings(token, corr(), input as never)).error?.code;
    expect(await code({ ...base, name: 5 })).toBe('invalid_input');
    expect(await code({ ...base, name: ' ' })).toBe('invalid_input');
    expect(await code({ ...base, mfa: 'weekly' })).toBe('invalid_input');
    expect(await code({ ...base, sessionIdleHours: '8' })).toBe('invalid_input');
    expect(await code({ ...base, sessionIdleHours: 0.5 })).toBe('invalid_input');
    expect(await code({ ...base, sessionIdleHours: 25 })).toBe('invalid_input');
    expect(await code({ ...base, reason: 7 })).toBe('invalid_input');
    expect(await code({ ...base, reason: 'x'.repeat(501) })).toBe('invalid_input');
    expect(await code({ ...base, mfa: 'required' })).toBe('invalid_input');
    expect(await code({ ...base, mfa: 'required', reason: '  ' })).toBe('invalid_input');
    expect(await code({ ...base, mfa: 'required', reason: 5 })).toBe('invalid_input');
    expect(await code({ ...base, mfa: 'required', reason: 'Política' })).toBeUndefined();
    expect(await code({ ...base, mfa: 'required', name: 'Alfa 2' })).toBeUndefined();
    expect(
      await code({ ...base, mfa: 'required', name: 'Alfa 3', reason: 'Informativo' }),
    ).toBeUndefined();
    const view = (await world.platform.getSettings(token, corr())).value;
    expect(view).toEqual({
      name: 'Alfa 3',
      status: 'active',
      mfa: 'required',
      sessionIdleHours: 8,
    });
    await world.platform.suspendTenant(a.tenantId);
    expect(world.platform.settings.get(a.tenantId, 'x').name).toBe('Alfa 3');
    const asViewer = await world.platform.updateSettings(viewer.token, corr(), base);
    expect(asViewer.error?.code).toBe('unauthorized');
    const actions = world.audit.list(a.tenantId).map((event) => event.action);
    expect(actions.filter((action) => action === 'tenant.security_settings_updated')).toHaveLength(
      1,
    );
    expect(actions.filter((action) => action === 'tenant.settings_updated')).toHaveLength(2);
  });

  it('shows a suspended status once the tenant is suspended even if settings were set', async () => {
    const { a } = await fixture();
    await world.platform.updateSettings(a.admin.token, corr(), {
      name: 'Alfa',
      mfa: 'disabled',
      sessionIdleHours: 8,
    });
    await world.platform.suspendTenant(a.tenantId);
    // The suspended tenant's own sessions are refused, so the view is only reachable by the operator.
    expect((await world.platform.getSettings(a.admin.token, corr())).ok).toBe(false);
    expect(world.platform.tenants.status(a.tenantId)).toBe('suspended');
  });

  it('validates draft scope and values and enforces the per-person cap', async () => {
    const { a, b } = await fixture();
    const { token } = a.admin;
    const save = async (scope: unknown, values: unknown) =>
      (await world.platform.saveDraft(token, corr(), scope as string, values)).error?.code;
    expect(await save(5, {})).toBe('invalid_input');
    expect(await save('-x', {})).toBe('invalid_input');
    expect(await save('ok', null)).toBe('invalid_input');
    expect(await save('ok', [])).toBe('invalid_input');
    expect(await save('ok', { a: 1 })).toBe('invalid_input');
    expect(await save('ok', { '': 'x' })).toBe('invalid_input');
    expect(await save('ok', { ['k'.repeat(65)]: 'x' })).toBe('invalid_input');
    expect(await save('ok', { a: 'x'.repeat(2001) })).toBe('invalid_input');
    expect(
      await save('ok', Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i}`, '']))),
    ).toBe('invalid_input');
    expect(
      await save(
        'ok',
        Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, 'v'.repeat(1990)])),
      ),
    ).toBe('invalid_input');
    expect(await save('ok', { a: 'b' })).toBeUndefined();
    const loaded = await world.platform.loadDraft(token, corr(), 'ok');
    expect(loaded.value?.values).toEqual({ a: 'b' });
    expect(Object.isFrozen(loaded.value?.values)).toBe(true);
    expect(
      (await world.platform.loadDraft(token, corr(), 5 as unknown as string)).error?.code,
    ).toBe('invalid_input');
    expect((await world.platform.discardDraft(token, corr(), '!')).error?.code).toBe(
      'invalid_input',
    );
    expect((await world.platform.discardDraft(token, corr(), 'ok')).ok).toBe(true);
    expect((await world.platform.discardDraft('bad', corr(), 'ok')).error?.code).toBe(
      'unauthorized',
    );
    expect((await world.platform.loadDraft('bad', corr(), 'ok')).error?.code).toBe('unauthorized');
    expect((await world.platform.saveDraft('bad', corr(), 'ok', {})).error?.code).toBe(
      'unauthorized',
    );
    for (let index = 0; index < MAX_DRAFTS_PER_ACTOR; index += 1)
      expect(await save(`s-${index}`, {})).toBeUndefined();
    expect(await save('overflow', {})).toBe('conflict');
    // The cap is per person and tenant.
    expect((await world.platform.saveDraft(b.admin.token, corr(), 'overflow', {})).ok).toBe(true);
  });
});
