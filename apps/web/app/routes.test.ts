import { describe, expect, it } from 'vitest';
import { isAllowed, matchPattern, resolveRoute, routes, safeNextPath } from './routes';

describe('route matching', () => {
  it('matches static and parameterised patterns and decodes parameters', () => {
    expect(matchPattern('/', '/')).toEqual({});
    expect(matchPattern('/invitacion/:token', '/invitacion/a%20b')).toEqual({ token: 'a b' });
    expect(matchPattern('/configuracion/roles', '/configuracion/roles/')).toEqual({});
  });

  it('rejects different lengths, different static segments and malformed encoding', () => {
    expect(matchPattern('/a/b', '/a')).toBeNull();
    expect(matchPattern('/a/b', '/a/c')).toBeNull();
    expect(matchPattern('/invitacion/:token', '/invitacion/%E0%A4%A')).toBeNull();
  });

  it('resolves known routes and returns null for unknown ones', () => {
    expect(resolveRoute('/configuracion/usuarios')?.route.id).toBe('users');
    expect(resolveRoute('/invitacion/abc')?.params).toEqual({ token: 'abc' });
    expect(resolveRoute('/nada')).toBeNull();
  });

  it('declares a permission for every configuration route and none for public ones', () => {
    const byId = Object.fromEntries(routes.map((route) => [route.id, route.access]));
    expect(byId.company).toEqual({ permission: 'manage_config' });
    expect(byId.users).toEqual({ permission: 'manage_users' });
    expect(byId.roles).toEqual({ permission: 'manage_users' });
    expect(byId.login).toBe('public');
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
      '/iniciar-sesion',
    ])
      expect(safeNextPath(unsafe)).toBe('/');
  });
});
