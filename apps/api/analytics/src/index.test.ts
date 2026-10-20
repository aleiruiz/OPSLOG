import { describe, expect, it } from 'vitest';
import { AnalyticsError, type Dashboard } from '../../../../packages/domain/analytics/src/index.js';
import { AuthError, type Permission } from '../../../../packages/domain/identity/src/index.js';
import {
  DASHBOARD_CACHE_MAX_ENTRIES,
  DashboardApi,
  authorizationVersion,
  type DashboardApiDeps,
} from './index.js';

const MINUTE = 60_000;

describe('DashboardApi cache', () => {
  const dashboard = (tag: string): Dashboard => ({
    asOf: tag,
    timeZone: 'UTC',
    today: '2026-10-19',
    range: { from: '2026-09-20', to: '2026-10-19' },
    areaId: null,
    expiryWindowDays: 30,
    widgets: [],
  });
  const resolved = {
    areaId: null as string | null,
    from: '2026-09-20',
    to: '2026-10-19',
    today: '2026-10-19',
    timeZone: 'UTC',
    expiryWindowDays: 30,
  };
  function build(over: Partial<DashboardApiDeps> = {}) {
    let clock = Date.parse('2026-10-19T12:00:00.000Z');
    let permissions: readonly Permission[] = ['view'];
    let tenantId = 'tenant-a';
    let computes = 0;
    let failNext: unknown = null;
    let resolve: typeof resolved = { ...resolved };
    const api = new DashboardApi({
      service: {
        resolve: async () => ({ ...resolve }),
        compute: async (_tenant: string, _query: unknown, granted: readonly Permission[]) => {
          computes += 1;
          if (failNext) {
            const error = failNext;
            failNext = null;
            throw error;
          }
          await Promise.resolve();
          return dashboard(`${tenantId}:${granted.join(',')}:${computes}`);
        },
      } as unknown as DashboardApiDeps['service'],
      authorize: async () => ({
        context: { tenantId } as never,
        permissions,
      }),
      now: () => new Date(clock),
      ...over,
    });
    return {
      api,
      advance: (ms: number) => (clock += ms),
      grant: (next: readonly Permission[]) => (permissions = next),
      as: (next: string) => (tenantId = next),
      fail: (error: unknown) => (failNext = error),
      filter: (next: Partial<typeof resolved>) => (resolve = { ...resolve, ...next }),
      computes: () => computes,
    };
  }

  it('serves the same figures for five minutes and recomputes afterwards', async () => {
    const t = build();
    const first = await t.api.get('t', 'c', {});
    t.advance(5 * MINUTE - 1);
    expect(await t.api.get('t', 'c', {})).toEqual(first);
    expect(t.computes()).toBe(1);
    t.advance(1);
    const second = await t.api.get('t', 'c', {});
    expect(second.value?.asOf).not.toBe(first.value?.asOf);
    expect(t.computes()).toBe(2);
  });

  it('keys the cache by company, authorization version and filters', async () => {
    const t = build();
    await t.api.get('t', 'c', {});
    t.as('tenant-b');
    expect((await t.api.get('t', 'c', {})).value?.asOf).toMatch(/^tenant-b/);
    t.as('tenant-a');
    t.filter({ areaId: 'area-1' });
    await t.api.get('t', 'c', {});
    t.filter({ areaId: null, from: '2026-10-01' });
    await t.api.get('t', 'c', {});
    expect(t.computes()).toBe(4);
    // Back to the first key: still warm.
    t.filter({ from: resolved.from });
    await t.api.get('t', 'c', {});
    expect(t.computes()).toBe(4);
  });

  it('applies a revocation inside the window on the very next call, with the same session', async () => {
    const t = build();
    t.grant(['view', 'incidents:view']);
    const before = await t.api.get('t', 'c', {});
    expect(before.value?.asOf).toContain('incidents:view');
    t.advance(MINUTE);
    t.grant(['view']);
    const after = await t.api.get('t', 'c', {});
    expect(after.value?.asOf).not.toContain('incidents:view');
    // Granting again within the window finds the first entry: it was built for exactly those rights.
    t.grant(['incidents:view', 'view']);
    expect((await t.api.get('t', 'c', {})).value).toEqual(before.value);
    expect(authorizationVersion(['view', 'view'])).toBe(authorizationVersion(['view']));
    expect(authorizationVersion(['view'])).not.toBe(authorizationVersion(['view_costs']));
  });

  it('shares one computation among concurrent identical calls and caches no failure', async () => {
    const t = build();
    const both = await Promise.all([t.api.get('t', 'c', {}), t.api.get('t', 'c', {})]);
    expect(both[0]).toEqual(both[1]);
    expect(t.computes()).toBe(1);
    const failing = build();
    failing.fail(new Error('store down: secret detail'));
    const failed = await failing.api.get('t', 'c', {});
    expect(failed).toEqual({
      ok: false,
      error: { code: 'internal_error', status: 500, message: 'Request failed' },
    });
    expect((await failing.api.get('t', 'c', {})).ok).toBe(true);
    expect(failing.computes()).toBe(2);
  });

  it('maps domain and authentication failures to their codes without echoing input', async () => {
    const cases: [unknown, string, number][] = [
      [new AnalyticsError('invalid_input', 'from'), 'invalid_input', 400],
      [new AnalyticsError('invalid_area', 'area_id'), 'invalid_area', 422],
      [new AuthError('unauthorized'), 'unauthorized', 401],
      [new AuthError('expired'), 'unauthorized', 401],
      [new AuthError('forbidden'), 'forbidden', 403],
      [new AuthError('invalid_input'), 'invalid_input', 400],
      [new AuthError('conflict'), 'internal_error', 500],
    ];
    for (const [error, code, status] of cases) {
      const t = build({
        authorize: async () => {
          throw error;
        },
      });
      const reply = await t.api.get('t', 'c', {});
      expect(reply.error).toMatchObject({ code, status });
      expect(JSON.stringify(reply)).not.toMatch(/from|area_id/);
    }
  });

  it('holds a bounded number of entries and drops expired ones first', async () => {
    expect(DASHBOARD_CACHE_MAX_ENTRIES).toBe(256);
    const t = build({ maxEntries: 3 });
    for (const from of ['2026-10-01', '2026-10-02', '2026-10-03']) {
      t.filter({ from });
      await t.api.get('t', 'c', {});
    }
    expect(t.computes()).toBe(3);
    // Everything is expired: a new key evicts them without touching the live one.
    t.advance(6 * MINUTE);
    t.filter({ from: '2026-10-04' });
    await t.api.get('t', 'c', {});
    t.filter({ from: '2026-10-05' });
    await t.api.get('t', 'c', {});
    t.filter({ from: '2026-10-06' });
    await t.api.get('t', 'c', {});
    // The oldest live entry went when the cache was full of live ones.
    t.filter({ from: '2026-10-07' });
    await t.api.get('t', 'c', {});
    t.filter({ from: '2026-10-04' });
    await t.api.get('t', 'c', {});
    expect(t.computes()).toBe(8);
    t.filter({ from: '2026-10-07' });
    await t.api.get('t', 'c', {});
    expect(t.computes()).toBe(8);
  });
});
