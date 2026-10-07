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

  it('maps the vehicle port to the generated vehicles client routes', async () => {
    const { api, calls } = scripted({});
    await api.vehicles.list({ limit: 25, status: 'active' });
    await api.vehicles.list();
    await api.vehicles.get('veh-1');
    await api.vehicles.create({
      economicNumber: 'ECO-1',
      plate: 'AB-1',
      make: 'M',
      model: 'X',
      year: 2020,
      areaId: 'a',
      odometerKm: 1,
    });
    await api.vehicles.update('veh-1', { version: 2, make: 'N' });
    await api.vehicles.recordOdometer('veh-1', { version: 3, odometerKm: 9 });
    await api.vehicles.archive('veh-1', 4);
    expect(calls.map((call) => call.id)).toEqual([
      'vehicles.list',
      'vehicles.list',
      'vehicles.get',
      'vehicles.create',
      'vehicles.update',
      'vehicles.odometer',
      'vehicles.archive',
    ]);
    expect(calls[0]?.input).toEqual({ query: { limit: 25, status: 'active' } });
    expect(calls[2]?.input).toEqual({ params: { id: 'veh-1' } });
    expect(calls[4]?.input).toEqual({ params: { id: 'veh-1' }, body: { version: 2, make: 'N' } });
    expect(calls[5]?.input).toEqual({
      params: { id: 'veh-1' },
      body: { version: 3, odometerKm: 9 },
    });
    expect(calls[6]?.input).toEqual({ params: { id: 'veh-1' }, body: { version: 4 } });
    // Status changes and history have no screen: the port does not expose them.
    expect(Object.keys(api.vehicles).sort()).toEqual(
      ['archive', 'create', 'get', 'list', 'recordOdometer', 'update'].sort(),
    );
  });

  it('maps every area call to its route, with the version in the body and the cursor in the query', async () => {
    const { api, calls } = scripted({});
    await api.areas.list();
    await api.areas.list({ limit: 100, includeInactive: 'true', parentId: 'root' });
    await api.areas.get('a-1');
    await api.areas.create({ name: 'Norte', responsibleIds: [] });
    await api.areas.update('a-1', { version: 2, parentId: null });
    await api.areas.deactivate('a-1', 3);
    await api.areas.activate('a-1', 4);
    await api.areas.history('a-1');
    await api.areas.history('a-1', { limit: 25, cursor: 'c' });
    expect(calls.map((call) => call.id)).toEqual([
      'areas.list',
      'areas.list',
      'areas.get',
      'areas.create',
      'areas.update',
      'areas.deactivate',
      'areas.activate',
      'areas.history',
      'areas.history',
    ]);
    expect(calls[1]?.input).toEqual({
      query: { limit: 100, includeInactive: 'true', parentId: 'root' },
    });
    expect(calls[4]?.input).toEqual({
      params: { id: 'a-1' },
      body: { version: 2, parentId: null },
    });
    expect(calls[5]?.input).toEqual({ params: { id: 'a-1' }, body: { version: 3 } });
    expect(calls[6]?.input).toEqual({ params: { id: 'a-1' }, body: { version: 4 } });
    expect(calls[8]?.input).toEqual({ params: { id: 'a-1' }, query: { limit: 25, cursor: 'c' } });
  });

  it('maps every employee call to its route, with the version in the body and the cursor in the query', async () => {
    const { api, calls } = scripted({});
    await api.employees.list();
    await api.employees.list({ limit: 25, kind: 'driver', status: 'active', areaId: 'a-1' });
    await api.employees.get('e-1');
    await api.employees.create({
      kind: 'other',
      firstName: 'Ana',
      lastName: 'Ruiz',
      areaId: 'a-1',
    });
    await api.employees.update('e-1', { version: 2, position: null });
    await api.employees.changeStatus('e-1', {
      version: 3,
      status: 'suspended',
      reason: 'Licencia',
    });
    await api.employees.archive('e-1', 4);
    await api.employees.history('e-1');
    await api.employees.history('e-1', { limit: 25, cursor: 'c' });
    expect(calls.map((call) => call.id)).toEqual([
      'employees.list',
      'employees.list',
      'employees.get',
      'employees.create',
      'employees.update',
      'employees.status',
      'employees.archive',
      'employees.history',
      'employees.history',
    ]);
    expect(calls[1]?.input).toEqual({
      query: { limit: 25, kind: 'driver', status: 'active', areaId: 'a-1' },
    });
    expect(calls[4]?.input).toEqual({
      params: { id: 'e-1' },
      body: { version: 2, position: null },
    });
    expect(calls[5]?.input).toEqual({
      params: { id: 'e-1' },
      body: { version: 3, status: 'suspended', reason: 'Licencia' },
    });
    expect(calls[6]?.input).toEqual({ params: { id: 'e-1' }, body: { version: 4 } });
    expect(calls[8]?.input).toEqual({ params: { id: 'e-1' }, query: { limit: 25, cursor: 'c' } });
  });

  it('maps every document and insurance call to its route, with the version in the body', async () => {
    const { api, calls } = scripted({});
    await api.documents.list();
    await api.documents.list({ limit: 25, ownerType: 'vehicle', status: 'expiring' });
    await api.documents.get('doc-1');
    await api.documents.create({
      ownerType: 'vehicle',
      ownerId: 'veh-1',
      typeCode: 'registration_card',
      title: 'Tarjeta',
      expiresOn: '2027-01-01',
    });
    await api.documents.update('doc-1', { version: 2, title: 'Otra' });
    await api.documents.renew('doc-1', { version: 3, expiresOn: '2028-01-01' });
    await api.documents.archive('doc-1', 4);
    await api.documents.history('doc-1');
    await api.documents.history('doc-1', { limit: 25, cursor: 'c' });
    await api.insurance.list();
    await api.insurance.list({ coversOn: '2026-10-06' });
    await api.insurance.get('pol-1');
    await api.insurance.create({
      vehicleId: 'veh-1',
      insurer: 'Aseguradora',
      policyNumber: 'P-1',
      coverageType: 'comprehensive',
      startsOn: '2026-01-01',
      endsOn: '2026-12-31',
    });
    await api.insurance.update('pol-1', { version: 2, insurer: 'Otra' });
    await api.insurance.renew('pol-1', {
      version: 3,
      startsOn: '2027-01-01',
      endsOn: '2027-12-31',
    });
    await api.insurance.archive('pol-1', 4);
    await api.insurance.history('pol-1');
    await api.insurance.history('pol-1', { limit: 50, cursor: 'c' });
    expect(calls.map((call) => call.id)).toEqual([
      'documents.list',
      'documents.list',
      'documents.get',
      'documents.create',
      'documents.update',
      'documents.renew',
      'documents.archive',
      'documents.history',
      'documents.history',
      'insurance.list',
      'insurance.list',
      'insurance.get',
      'insurance.create',
      'insurance.update',
      'insurance.renew',
      'insurance.archive',
      'insurance.history',
      'insurance.history',
    ]);
    expect(calls[4]?.input).toEqual({
      params: { id: 'doc-1' },
      body: { version: 2, title: 'Otra' },
    });
    expect(calls[6]?.input).toEqual({ params: { id: 'doc-1' }, body: { version: 4 } });
    expect(calls[8]?.input).toEqual({ params: { id: 'doc-1' }, query: { limit: 25, cursor: 'c' } });
    expect(calls[10]?.input).toEqual({ query: { coversOn: '2026-10-06' } });
    expect(calls[15]?.input).toEqual({ params: { id: 'pol-1' }, body: { version: 4 } });
  });

  it('maps the alert calls to their routes, with the version in the settings body', async () => {
    const { api, calls } = scripted({});
    await api.alerts.list();
    await api.alerts.list({ limit: 50, source: 'insurance_policy', severity: 'expired' });
    await api.alerts.settings();
    await api.alerts.saveSettings({
      version: 0,
      expiryWindowDays: 15,
      recipientRoles: ['admin', 'viewer'],
    });
    expect(calls.map((call) => call.id)).toEqual([
      'alerts.list',
      'alerts.list',
      'alerts.settings.get',
      'alerts.settings.update',
    ]);
    expect(calls[1]?.input).toEqual({
      query: { limit: 50, source: 'insurance_policy', severity: 'expired' },
    });
    expect(calls[3]?.input).toEqual({
      body: { version: 0, expiryWindowDays: 15, recipientRoles: ['admin', 'viewer'] },
    });
  });

  it('maps every assignment and import call to its route', async () => {
    const { api, calls } = scripted({});
    await api.assignments.list();
    await api.assignments.list({ vehicleId: 'veh-1', current: true });
    await api.assignments.get('asg-1');
    await api.assignments.assign({
      vehicleId: 'veh-1',
      employeeId: 'emp-1',
      type: 'principal',
      reason: 'Ruta',
      replace: true,
    });
    await api.assignments.end('asg-1', { version: 2, reason: 'Fin' });
    await api.assignments.history('asg-1');
    await api.assignments.history('asg-1', { limit: 50, cursor: 'c' });
    await api.imports.list();
    await api.imports.list({ entity: 'vehicle' });
    await api.imports.get('imp-1');
    await api.imports.submit({ entity: 'vehicle', mode: 'dry_run', csv: 'a' });
    await api.imports.rows('imp-1');
    await api.imports.rows('imp-1', { outcome: 'invalid', limit: 25 });
    await api.imports.history('imp-1');
    await api.imports.history('imp-1', { limit: 25 });
    expect(calls.map((call) => call.id)).toEqual([
      'assignments.list',
      'assignments.list',
      'assignments.get',
      'assignments.create',
      'assignments.end',
      'assignments.history',
      'assignments.history',
      'imports.list',
      'imports.list',
      'imports.get',
      'imports.create',
      'imports.rows',
      'imports.rows',
      'imports.history',
      'imports.history',
    ]);
    expect(calls[1]?.input).toEqual({ query: { vehicleId: 'veh-1', current: true } });
    expect(calls[4]?.input).toEqual({
      params: { id: 'asg-1' },
      body: { version: 2, reason: 'Fin' },
    });
    expect(calls[10]?.input).toEqual({
      body: { entity: 'vehicle', mode: 'dry_run', csv: 'a' },
    });
    expect(calls[12]?.input).toEqual({
      params: { id: 'imp-1' },
      query: { outcome: 'invalid', limit: 25 },
    });
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
