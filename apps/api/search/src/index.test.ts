import { describe, expect, it } from 'vitest';
import { SearchError } from '../../../../packages/domain/search/src/index.js';
import { SearchApi } from './index.js';
import type { SearchApiDeps } from './types.js';

const session = { tenantId: 't1', subject: 'u1', permissions: ['view', 'incidents:view'] };

function api(over: Partial<SearchApiDeps> = {}) {
  const calls: unknown[][] = [];
  const deps: SearchApiDeps = {
    authorize: async () => session,
    mechanicLinked: async () => true,
    service: {
      search: async (...args) => {
        calls.push(args);
        return { groups: [] };
      },
    },
    ...over,
  };
  return { api: new SearchApi(deps), calls };
}

describe('SearchApi', () => {
  it('searches the company and grants of the session, never what the query names', async () => {
    const { api: search, calls } = api();
    const result = await search.search('token', 'corr', { q: 'abc', types: ['vehicle'] });
    expect(result).toEqual({ ok: true, value: { groups: [] } });
    const [tenant, who, q, types] = calls[0] as [
      string,
      { permissions: Set<string>; mechanicLinked: boolean },
      string,
      string[],
    ];
    expect(tenant).toBe('t1');
    expect([...who.permissions]).toEqual(['view', 'incidents:view']);
    expect(who.mechanicLinked).toBe(true);
    expect(q).toBe('abc');
    expect(types).toEqual(['vehicle']);
  });

  it('maps failures to fixed codes without echoing anything', async () => {
    const codes = async (error: unknown) => {
      const { api: search } = api({
        authorize: async () => {
          throw error;
        },
      });
      const result = await search.search('t', 'c', { q: 'secret-term' });
      return result.ok ? null : result.error;
    };
    expect(await codes({ code: 'unauthorized' })).toMatchObject({
      code: 'unauthorized',
      status: 401,
    });
    expect(await codes({ code: 'expired' })).toMatchObject({ code: 'unauthorized', status: 401 });
    expect(await codes({ code: 'forbidden' })).toMatchObject({ code: 'forbidden', status: 403 });
    expect(await codes(new SearchError('invalid_input'))).toMatchObject({ status: 400 });
    const unknown = await codes(new Error('db password=hunter2'));
    expect(unknown).toEqual({ code: 'internal_error', status: 500, message: 'Request failed' });
    expect(await codes(null)).toMatchObject({ code: 'internal_error' });
  });

  it('maps a search rejection of the service to a 400', async () => {
    const { api: search } = api({
      service: {
        search: async () => {
          throw new SearchError('invalid_input');
        },
      },
    });
    expect(await search.search('t', 'c', { q: 1 })).toMatchObject({
      ok: false,
      error: { code: 'invalid_input', status: 400 },
    });
  });
});
