import { describe, expect, it } from 'vitest';
import { BFF_ERRORS, BFF_ROUTES, bffPath, bffRouteIds, isBffErrorBody } from './index.js';

describe('BFF contract', () => {
  it('declares unique method and path pairs', () => {
    const keys = bffRouteIds.map(
      (id) => `${BFF_ROUTES[id].method} /${BFF_ROUTES[id].path.join('/')}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
    expect(bffRouteIds.length).toBeGreaterThan(10);
  });

  it('builds encoded paths and query strings', () => {
    expect(bffPath('auth.csrf')).toBe('/api/auth/csrf');
    expect(bffPath('users.deactivate', { id: 'a/b c' })).toBe('/api/users/a%2Fb%20c/deactivate');
    expect(bffPath('users.list', {}, { limit: 25, cursor: undefined, search: 'a b' })).toBe(
      '/api/users?limit=25&search=a+b',
    );
    expect(bffPath('drafts.load', {})).toBe('/api/drafts/');
  });

  it('recognises uniform error bodies only', () => {
    const body = {
      code: 'forbidden',
      status: 403,
      message: 'Permission denied',
      correlationId: 'c',
    };
    expect(isBffErrorBody(body)).toBe(true);
    expect(isBffErrorBody({ ...body, code: 'other' })).toBe(false);
    expect(isBffErrorBody({ ...body, status: '403' })).toBe(false);
    expect(isBffErrorBody(null)).toBe(false);
    expect(Object.keys(BFF_ERRORS)).toContain('csrf_failed');
  });
});
