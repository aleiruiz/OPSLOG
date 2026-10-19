import { describe, expect, it } from 'vitest';
import {
  InMemorySavedViewStore,
  SavedViewError,
  SavedViewService,
} from '../../../../packages/domain/saved-views/src/index.js';
import { catalog } from '../../../../packages/domain/saved-views/src/test-support.js';
import { SavedViewsApi } from './index.js';
import type { SavedViewsApiDeps } from './types.js';

function api(
  permissions: string[] = ['view'],
  subject = 'u1',
  over: Partial<SavedViewsApiDeps> = {},
) {
  const service = new SavedViewService(new InMemorySavedViewStore(), catalog);
  const deps: SavedViewsApiDeps = {
    authorize: async () => ({ tenantId: 't1', subject, permissions }),
    service,
    ...over,
  };
  return new SavedViewsApi(deps);
}

describe('SavedViewsApi', () => {
  it('serves the company and reader of the session, never what the request names', async () => {
    const views = api();
    const created = await views.create('tok', 'c', 'maintenance', {
      name: 'Mía',
      tenantId: 'other',
    });
    expect(created).toMatchObject({ ok: true, value: { name: 'Mía', mine: true } });
    const listed = await views.list('tok', 'c', 'maintenance');
    expect(listed.ok && listed.value.items).toHaveLength(1);
  });

  it('runs the whole life of a view and of the columns', async () => {
    const views = api();
    const created = await views.create('tok', 'c', 'maintenance', { name: 'Uno' });
    if (!created.ok) throw new Error('create failed');
    const updated = await views.update('tok', 'c', created.value.id, { version: 1, name: 'Dos' });
    expect(updated).toMatchObject({ ok: true, value: { name: 'Dos', version: 2 } });
    expect(await views.remove('tok', 'c', created.value.id)).toEqual({ ok: true });
    const saved = await views.saveColumns('tok', 'c', 'maintenance', ['folio']);
    expect(saved).toMatchObject({ ok: true, value: { columns: ['folio'] } });
    expect(await views.columns('tok', 'c', 'maintenance')).toMatchObject({
      ok: true,
      value: { columns: ['folio'] },
    });
  });

  it.each([
    ['invalid_input', 400],
    ['forbidden', 403],
    ['not_found', 404],
    ['stale_version', 409],
    ['duplicate', 409],
  ] as const)('answers %s with %i and a fixed message', async (code, status) => {
    const views = api(['view'], 'u1', {
      service: {
        ...new SavedViewService(new InMemorySavedViewStore(), catalog),
        list: async () => {
          throw new SavedViewError(code);
        },
      } as unknown as SavedViewsApiDeps['service'],
    });
    const result = await views.list('tok', 'c', 'maintenance');
    expect(result).toEqual({
      ok: false,
      error: { code, status, message: `Saved view request rejected: ${code}` },
    });
  });

  it('answers the limit as a 422 rule violation named view_limit', async () => {
    const views = api(['view'], 'u1', {
      service: {
        create: async () => {
          throw new SavedViewError('limit_reached');
        },
      } as unknown as SavedViewsApiDeps['service'],
    });
    expect(await views.create('tok', 'c', 'maintenance', { name: 'x' })).toEqual({
      ok: false,
      error: {
        code: 'rule_violation',
        status: 422,
        message: 'Saved view request rejected: rule_violation',
        rule: 'view_limit',
      },
    });
  });

  it('maps an expired session to 401 and anything else to a plain 500', async () => {
    const expired = api(['view'], 'u1', {
      authorize: async () => {
        throw Object.assign(new Error('secret detail'), { code: 'expired' });
      },
    });
    expect(await expired.list('t', 'c', 'maintenance')).toMatchObject({
      ok: false,
      error: { code: 'unauthorized', status: 401 },
    });
    const broken = api(['view'], 'u1', {
      authorize: async () => {
        throw new Error('db password leaked');
      },
    });
    const result = await broken.list('t', 'c', 'maintenance');
    expect(result).toEqual({
      ok: false,
      error: { code: 'internal_error', status: 500, message: 'Request failed' },
    });
    expect(JSON.stringify(result)).not.toContain('password');
  });
});
