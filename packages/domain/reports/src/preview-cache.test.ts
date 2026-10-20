import { describe, expect, it } from 'vitest';
import { PreviewCache } from './preview-cache.js';
import { ALL, MemorySources, READER, companyA, companyB, engineFor } from './test-support.js';
import type { ReportPlan, ReportResult } from './types.js';

const result = (rows: number): ReportResult => ({
  columns: [],
  rows: Array.from({ length: rows }, () => ({})),
  total: rows,
});

describe('PreviewCache', () => {
  it('returns a result until its time is up and then forgets it', () => {
    let now = 0;
    const cache = new PreviewCache(() => now, 1000, 100);
    const stored = result(3);
    cache.set('a', stored);
    expect(cache.get('a')).toBe(stored);
    now = 999;
    expect(cache.get('a')).toBe(stored);
    now = 1000;
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('never')).toBeUndefined();
  });

  it('keeps at most the budget of rows, dropping the oldest entries, and never keeps an oversized result', () => {
    const cache = new PreviewCache(() => 0, 1000, 10);
    cache.set('a', result(6));
    cache.set('b', result(6));
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeDefined();
    cache.set('huge', result(11));
    expect(cache.get('huge')).toBeUndefined();
    cache.set('b', result(2));
    expect(cache.get('b')?.rows).toHaveLength(2);
  });

  it('keys by company, reader, permissions and the whole plan', async () => {
    const { engine } = engineFor();
    const planOf = (permissions: readonly string[], request = {}) =>
      engine.plan('drivers', new Set(permissions) as never, request) as ReportPlan;
    const key = (plan: ReportPlan, tenant = 'A', actor: string | null = 'x', perms = READER) =>
      PreviewCache.key(tenant, actor ?? undefined, new Set(perms), plan);
    const base = key(planOf(READER));
    expect(key(planOf(READER))).toBe(base);
    expect(key(planOf(READER), 'B')).not.toBe(base);
    expect(key(planOf(READER), 'A', 'y')).not.toBe(base);
    expect(key(planOf(READER), 'A', null)).not.toBe(base);
    expect(key(planOf(READER), 'A', 'x', ALL)).not.toBe(base);
    expect(key(planOf(READER, { sort: 'area' }))).not.toBe(base);
    expect(key(planOf(READER, { filters: { status: 'active' } }))).not.toBe(base);
    expect(key(planOf(READER, { columns: ['name'] }))).not.toBe(base);
  });
});

describe('ReportEngine.preview', () => {
  it('loads the report once for the pages of the same plan and reader, and again for another', async () => {
    let loads = 0;
    class Counting extends MemorySources {
      public override async vehicles(tenantId: string) {
        loads += 1;
        return super.vehicles(tenantId);
      }
    }
    const { engine } = engineFor(new Counting({ A: companyA(), B: companyB() }));
    const permissions = new Set(READER);
    const ctx = await engine.context('A', permissions, 'actor-1');
    const plan = engine.plan('vehicle_inventory', permissions, {});
    const first = await engine.preview(ctx, plan);
    const second = await engine.preview(ctx, plan);
    expect(second).toBe(first);
    expect(loads).toBe(1);
    // A different reader of the same company does not reuse the result; an export (`run`) always loads afresh.
    await engine.preview(await engine.context('A', permissions, 'actor-2'), plan);
    expect(loads).toBe(2);
    await engine.run(ctx, plan);
    expect(loads).toBe(3);
  });
});
