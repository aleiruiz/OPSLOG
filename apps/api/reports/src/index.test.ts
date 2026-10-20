import { describe, expect, it, vi } from 'vitest';
import { AuthError } from '../../../../packages/domain/identity/src/index.js';
import { ALL, READER, engineFor } from '../../../../packages/domain/reports/src/test-support.js';
import { ReportsApi } from './index.js';

function api(permissions: readonly string[] = ALL, tenantId = 'A', fixture = engineFor()) {
  return new ReportsApi({
    engine: fixture.engine,
    authorize: async (token) => {
      if (token === 'bad') throw new AuthError('unauthorized');
      return { tenantId, subject: 'u1', sessionId: 's', permissions };
    },
  });
}

describe('ReportsApi', () => {
  it('lists the catalog the reader may see and says whether they can export', async () => {
    const full = await api().catalog('t', 'c');
    expect(full.ok && full.value.reports.map((r) => r.id)).toContain('drivers');
    expect(full.ok && full.value.canExport).toBe(true);
    const reader = await api(READER).catalog('t', 'c');
    expect(reader.ok && reader.value.canExport).toBe(false);
    expect(await api().catalog('bad', 'c')).toMatchObject({ error: { status: 401 } });
  });

  it('pages a preview and removes columns the reader may not see', async () => {
    const full = await api().preview('t', 'c', 'drivers', { limit: 1 });
    if (!full.ok) throw new Error('expected ok');
    expect(full.value.rows).toHaveLength(1);
    expect(full.value.total).toBeGreaterThan(1);
    expect(full.value.rows[0]).toHaveLength(full.value.columns.length);
    const second = await api().preview('t', 'c', 'drivers', { limit: 1, offset: 1 });
    expect(second.ok && second.value.rows[0]).not.toEqual(full.value.rows[0]);
    const piiFree = await api(READER).preview('t', 'c', 'dispatchers', {
      columns: ['name', 'phone'],
    });
    expect(piiFree.ok && piiFree.value.columns.map((c) => c.id)).toEqual(['name']);
  });

  it('loads the report once for all the pages of a preview and once per reader', async () => {
    const fixture = engineFor();
    const loads = vi.spyOn(fixture.sources, 'people');
    const reports = api(ALL, 'A', fixture);
    await reports.preview('t', 'c', 'drivers', { limit: 1 });
    await reports.preview('t', 'c', 'drivers', { limit: 1, offset: 1 });
    expect(loads).toHaveBeenCalledTimes(1);
    // Another report or another filter is another load.
    await reports.preview('t', 'c', 'drivers', { limit: 1, filters: { status: 'active' } });
    expect(loads).toHaveBeenCalledTimes(2);
  });

  it('rejects a bad window, an unknown report, an unknown filter and a hidden sort', async () => {
    for (const request of [{ limit: 0 }, { limit: 101 }, { offset: -1 }, { limit: 1.5 }])
      expect(await api().preview('t', 'c', 'drivers', request)).toMatchObject({
        error: { status: 400, field: 'limit' },
      });
    expect(await api().preview('t', 'c', 'nope', {})).toMatchObject({ error: { status: 404 } });
    expect(await api().preview('t', 'c', 'drivers', { filters: { nope: 'x' } })).toMatchObject({
      error: { status: 400 },
    });
    expect(await api(['export']).preview('t', 'c', 'drivers', {})).toMatchObject({
      error: { status: 403 },
    });
    expect(await api().preview('bad', 'c', 'drivers', {})).toMatchObject({
      error: { status: 401 },
    });
  });
});
