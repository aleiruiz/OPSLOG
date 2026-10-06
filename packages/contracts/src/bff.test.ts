import { describe, expect, it } from 'vitest';
import {
  BFF_ERRORS,
  BFF_IMPORT_MAX_BODY_BYTES,
  BFF_IMPORT_MAX_ROWS,
  BFF_IMPORT_TEMPLATES,
  BFF_ROUTES,
  bffPath,
  bffRouteIds,
  isBffErrorBody,
} from './index.js';

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
    expect(() => bffPath('drafts.load', {})).toThrow(/Missing path parameter :scope/);
    expect(() => bffPath('drafts.load', { scope: '' })).toThrow();
  });

  it('gives the bulk import route a larger body limit than the default, and nothing else', () => {
    const limited = Object.entries(BFF_ROUTES).filter(
      ([, definition]) => 'maxBodyBytes' in definition,
    );
    expect(limited.map(([id]) => id)).toEqual(['imports.create']);
    expect(BFF_IMPORT_MAX_BODY_BYTES).toBeGreaterThan(16 * 1024);
    expect(BFF_IMPORT_MAX_ROWS).toBe(500);
    expect(BFF_IMPORT_TEMPLATES.vehicle.required).toContain('plate');
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
