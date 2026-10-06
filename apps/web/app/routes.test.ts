import { describe, expect, it } from 'vitest';
import { isAllowed, matchPattern, resolveRoute, routes, safeNextPath } from './routes';

describe('route matching', () => {
  it('matches static and parameterised patterns and decodes parameters', () => {
    expect(matchPattern('/', '/')).toEqual({});
    expect(matchPattern('/invitacion/:token', '/invitacion/dos%20palabras')).toEqual({
      token: 'dos palabras',
    });
    expect(matchPattern('/configuracion/roles', '/configuracion/roles/')).toEqual({});
  });

  it('rejects different lengths, different static segments and malformed encoding', () => {
    expect(matchPattern('/a/b', '/a')).toBeNull();
    expect(matchPattern('/a/b', '/a/c')).toBeNull();
    expect(matchPattern('/invitacion/:token', '/invitacion/%zz')).toBeNull();
  });

  it('resolves known routes and returns null for unknown ones', () => {
    expect(resolveRoute('/configuracion/usuarios')?.route.id).toBe('users');
    expect(resolveRoute('/invitacion/abc')?.params).toEqual({ token: 'abc' });
    expect(resolveRoute('/nada')).toBeNull();
  });

  it('resolves the vehicle screens, with "nuevo" taking precedence over the id', () => {
    expect(resolveRoute('/flota/vehiculos')?.route.id).toBe('vehicles');
    expect(resolveRoute('/flota/vehiculos/nuevo')?.route.id).toBe('vehicleNew');
    expect(resolveRoute('/flota/vehiculos/veh-1')).toMatchObject({
      route: { id: 'vehicleDetail' },
      params: { id: 'veh-1' },
    });
    expect(resolveRoute('/flota/vehiculos/veh-1/editar')).toMatchObject({
      route: { id: 'vehicleEdit' },
      params: { id: 'veh-1' },
    });
    expect(resolveRoute('/flota/vehiculos/a/b/c')).toBeNull();
    // Only the lists are in the navigation, under "Flota".
    expect(routes.filter((route) => route.nav?.group === 'Flota').map((route) => route.id)).toEqual(
      ['vehicles', 'documents', 'policies'],
    );
  });

  it('resolves the document and policy screens, with "nuevo"/"nueva" taking precedence over the id', () => {
    expect(resolveRoute('/flota/documentos')?.route.id).toBe('documents');
    expect(resolveRoute('/flota/documentos/nuevo')?.route.id).toBe('documentNew');
    expect(resolveRoute('/flota/documentos/d-1')).toMatchObject({
      route: { id: 'documentDetail' },
      params: { id: 'd-1' },
    });
    expect(resolveRoute('/flota/documentos/d-1/editar')?.route.id).toBe('documentEdit');
    expect(resolveRoute('/flota/documentos/d-1/renovar')?.route.id).toBe('documentRenew');
    expect(resolveRoute('/flota/documentos/a/b/c')).toBeNull();
    expect(resolveRoute('/flota/seguros')?.route.id).toBe('policies');
    expect(resolveRoute('/flota/seguros/nueva')?.route.id).toBe('policyNew');
    expect(resolveRoute('/flota/seguros/p-1')).toMatchObject({
      route: { id: 'policyDetail' },
      params: { id: 'p-1' },
    });
    expect(resolveRoute('/flota/seguros/p-1/editar')?.route.id).toBe('policyEdit');
    expect(resolveRoute('/flota/seguros/p-1/renovar')?.route.id).toBe('policyRenew');
    const byId = Object.fromEntries(routes.map((route) => [route.id, route.access]));
    for (const id of ['documents', 'documentDetail', 'policies', 'policyDetail'])
      expect(byId[id]).toEqual({ permission: 'view' });
    for (const id of ['documentNew', 'policyNew'])
      expect(byId[id]).toEqual({ permission: 'create' });
    for (const id of ['documentEdit', 'documentRenew', 'policyEdit', 'policyRenew'])
      expect(byId[id]).toEqual({ permission: 'edit' });
  });

  it('resolves the area screens, with "nueva" taking precedence over the id, under the "Plantilla" group', () => {
    expect(resolveRoute('/plantilla/areas')?.route.id).toBe('areas');
    expect(resolveRoute('/plantilla/areas/nueva')?.route.id).toBe('areaNew');
    expect(resolveRoute('/plantilla/areas/a-1')).toMatchObject({
      route: { id: 'areaDetail' },
      params: { id: 'a-1' },
    });
    expect(resolveRoute('/plantilla/areas/a-1/editar')?.route.id).toBe('areaEdit');
    expect(resolveRoute('/plantilla/areas/a-1/mover')?.route.id).toBe('areaMove');
    expect(resolveRoute('/plantilla/areas/a/b/c')).toBeNull();
    expect(
      routes.filter((route) => route.nav?.group === 'Plantilla').map((route) => route.id),
    ).toEqual(['areas']);
    const byId = Object.fromEntries(routes.map((route) => [route.id, route.access]));
    expect(byId.areas).toEqual({ permission: 'view' });
    expect(byId.areaNew).toEqual({ permission: 'create' });
    expect(byId.areaDetail).toEqual({ permission: 'view' });
    expect(byId.areaEdit).toEqual({ permission: 'edit' });
    expect(byId.areaMove).toEqual({ permission: 'edit' });
  });

  it('declares a permission for every configuration route and none for public ones', () => {
    const byId = Object.fromEntries(routes.map((route) => [route.id, route.access]));
    expect(byId.company).toEqual({ permission: 'manage_config' });
    expect(byId.users).toEqual({ permission: 'manage_users' });
    expect(byId.roles).toEqual({ permission: 'manage_users' });
    expect(byId.login).toBe('public');
    expect(byId.vehicles).toEqual({ permission: 'view' });
    expect(byId.vehicleNew).toEqual({ permission: 'create' });
    expect(byId.vehicleDetail).toEqual({ permission: 'view' });
    expect(byId.vehicleEdit).toEqual({ permission: 'edit' });
    expect(byId.invitation).toBe('public');
  });
});

describe('route access', () => {
  it('evaluates permissions only for permission-gated routes', () => {
    const none = () => false;
    expect(isAllowed('public', none)).toBe(true);
    expect(isAllowed('authenticated', none)).toBe(true);
    expect(isAllowed({ permission: 'manage_users' }, none)).toBe(false);
    expect(isAllowed({ permission: 'manage_users' }, (p) => p === 'manage_users')).toBe(true);
  });

  it('only accepts same-app absolute paths as post-login destination', () => {
    expect(safeNextPath('/configuracion/roles')).toBe('/configuracion/roles');
    for (const unsafe of [
      null,
      '',
      'https://evil.example',
      '//evil.example',
      '/\\evil',
      '/a\tb',
      '/a\nb',
      '/a\u0000b',
      '/iniciar-sesion',
    ])
      expect(safeNextPath(unsafe)).toBe('/');
  });
});
