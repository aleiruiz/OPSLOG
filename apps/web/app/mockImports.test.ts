import { describe, expect, it } from 'vitest';
import { normalizePlate } from '../vehicles/rules';
import { createMockImportStore, importWritesPii, type MockImportEnvironment } from './mockImports';

const created: { entity: string; input: Record<string, unknown> }[] = [];
const env = (overrides: Partial<MockImportEnvironment> = {}): MockImportEnvironment => ({
  isActiveArea: (id) => id === 'area-norte',
  existingKeys: () => new Set([`plate:${normalizePlate('DUP-1')}`]),
  createRecord: async (entity, input) => {
    created.push({ entity, input });
    return { ok: true, value: { id: `new-${created.length}` } };
  },
  actorId: () => 'user-test',
  ...overrides,
});
const header = 'economicNumber,plate,make,model,year,areaId,odometerKm';
const row = (n: number, plate = `P-${n}`) => `E-${n},${plate},Nissan,NP300,2022,area-norte,10`;
const csv = (...rows: string[]) => [header, ...rows].join('\n');
const fresh = (overrides: Partial<MockImportEnvironment> = {}) =>
  createMockImportStore(env(overrides), []);
const input = (extra: Record<string, unknown>) =>
  ({ entity: 'vehicle', mode: 'dry_run', csv: csv(row(1)), ...extra }) as never;
const KEY = 'key-12345678';
const status = (result: unknown) => (result as { error: { status: number } }).error.status;
const value = <T>(result: unknown) => (result as { value: T }).value;

describe('mock import store', () => {
  it('validates without creating, row by row, naming columns and never values', async () => {
    created.length = 0;
    const store = fresh();
    const result = await store.port.submit(
      input({ csv: csv(row(1), 'E-2,,Nissan,NP300,2022,area-norte,10', row(3, 'DUP-1'), row(1)) }),
    );
    const { job, replayed } = value<{
      job: { id: string; invalidRows: number };
      replayed: boolean;
    }>(result);
    expect(replayed).toBe(false);
    expect(job).toMatchObject({ status: 'validated', totalRows: 4, validRows: 1, invalidRows: 3 });
    expect(created).toEqual([]);
    const rows = value<{ items: { code: string | null; columns: string[]; outcome: string }[] }>(
      await store.port.rows(job.id),
    ).items;
    expect(rows.map((item) => [item.outcome, item.code, item.columns])).toEqual([
      ['valid', null, []],
      ['invalid', 'missing_value', ['plate']],
      ['invalid', 'duplicate', ['plate']],
      ['invalid', 'duplicate_in_file', ['economicNumber']],
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/Nissan|E-2|DUP-1/);
    const events = value<{ items: { kind: string }[] }>(await store.port.history(job.id));
    expect(events.items.map((event) => event.kind)).toEqual(['validated', 'started']);
  });

  it('rejects a row with an unknown area, a bad value or a formula', async () => {
    const store = fresh();
    const { job } = value<{ job: { id: string } }>(
      await store.port.submit(
        input({
          csv: csv(
            'E-1,P-1,Nissan,NP300,2022,area-otra,10',
            'E-2,P-2,Nissan,NP300,abc,area-norte,10',
            'E-3,P-3,=SUM(A1),NP300,2022,area-norte,10',
          ),
        }),
      ),
    );
    const rows = value<{ items: { code: string }[] }>(
      await store.port.rows(job.id, { outcome: 'invalid' }),
    ).items;
    expect(rows.map((item) => item.code)).toEqual([
      'invalid_area',
      'invalid_value',
      'formula_injection',
    ]);
  });

  it('commits the valid rows, or all or nothing, and replays the same key', async () => {
    created.length = 0;
    const store = fresh();
    const mixed = csv(row(1), row(2, 'DUP-1'));
    const some = value<{ job: { status: string; importedRows: number } }>(
      await store.port.submit(input({ mode: 'commit_valid', csv: mixed, idempotencyKey: KEY })),
    );
    expect(some.job).toMatchObject({ status: 'imported', importedRows: 1 });
    expect(created).toHaveLength(1);
    const replay = await store.port.submit(
      input({ mode: 'commit_valid', csv: mixed, idempotencyKey: KEY }),
    );
    expect(value<{ replayed: boolean }>(replay).replayed).toBe(true);
    expect(created).toHaveLength(1);
    expect(
      status(
        await store.port.submit(
          input({ mode: 'commit_valid', csv: csv(row(9)), idempotencyKey: KEY }),
        ),
      ),
    ).toBe(409);
    expect(
      status(
        await store.port.submit(input({ mode: 'commit_all', csv: mixed, idempotencyKey: KEY })),
      ),
    ).toBe(409);
    const all = value<{ job: { status: string; importedRows: number; id: string } }>(
      await store.port.submit(
        input({ mode: 'commit_all', csv: mixed, idempotencyKey: 'key-87654321' }),
      ),
    );
    expect(all.job).toMatchObject({ status: 'failed', importedRows: 0 });
    expect(created).toHaveLength(1);
    const skipped = value<{ items: { outcome: string }[] }>(await store.port.rows(all.job.id));
    expect(skipped.items.map((item) => item.outcome)).toEqual(['skipped', 'invalid']);
    const clean = value<{ job: { status: string; importedRows: number } }>(
      await store.port.submit(
        input({ mode: 'commit_all', csv: csv(row(5)), idempotencyKey: 'key-11223344' }),
      ),
    );
    expect(clean.job).toMatchObject({ status: 'imported', importedRows: 1 });
  });

  it('reports a row the record store refuses, by the columns it names', async () => {
    const store = fresh({
      createRecord: async () =>
        ({
          ok: false,
          error: {
            code: 'invalid',
            status: 422,
            message: 'x',
            correlationId: 'c',
            fieldErrors: [{ field: 'odometer_km', code: 'x' }],
          },
        }) as never,
    });
    const { job } = value<{ job: { id: string; importedRows: number } }>(
      await store.port.submit(
        input({ mode: 'commit_valid', csv: csv(row(1)), idempotencyKey: KEY }),
      ),
    );
    expect(job.importedRows).toBe(0);
    const rows = value<{ items: { code: string; columns: string[] }[] }>(
      await store.port.rows(job.id),
    );
    expect(rows.items[0]).toMatchObject({ code: 'invalid_value', columns: ['odometerKm'] });
    for (const code of ['duplicate', 'invalid_area']) {
      const other = fresh({
        createRecord: async () =>
          ({ ok: false, error: { code, status: 409, message: 'x', correlationId: 'c' } }) as never,
      });
      const made = value<{ job: { id: string } }>(
        await other.port.submit(
          input({ mode: 'commit_valid', csv: csv(row(1)), idempotencyKey: KEY }),
        ),
      );
      expect(
        value<{ items: { code: string }[] }>(await other.port.rows(made.job.id)).items[0]?.code,
      ).toBe(code);
    }
  });

  it('links a commit to its validation of the same file only', async () => {
    const store = fresh();
    const { job } = value<{ job: { id: string } }>(await store.port.submit(input({})));
    const commit = (extra: Record<string, unknown>) =>
      store.port.submit(input({ mode: 'commit_all', idempotencyKey: 'key-aaaaaaaa', ...extra }));
    expect(status(await commit({ dryRunJobId: 'imp-desconocida' }))).toBe(404);
    expect(status(await commit({ dryRunJobId: job.id, csv: csv(row(7)) }))).toBe(409);
    expect(value<{ replayed: boolean }>(await commit({ dryRunJobId: job.id })).replayed).toBe(
      false,
    );
  });

  it('refuses malformed requests with a uniform 400', async () => {
    const store = fresh();
    const bad: Record<string, unknown>[] = [
      { entity: 'otro' },
      { mode: 'otro' },
      { extra: 1 },
      { rows: [] },
      { csv: undefined },
      { mode: 'commit_all' },
      { mode: 'commit_all', idempotencyKey: 'corta' },
      { idempotencyKey: 'key-12345678', mode: 'dry_run', dryRunJobId: 'imp-1' },
      { mode: 'commit_all', idempotencyKey: KEY, dryRunJobId: '!!' },
      { csv: header },
      { csv: 'a,"b' },
      { csv: csv(...Array.from({ length: 501 }, (_, i) => row(i))) },
      { csv: `${header},color\n${row(1)},x` },
    ];
    for (const extra of bad) {
      const request = { ...(input({}) as Record<string, unknown>), ...extra };
      for (const key of Object.keys(request)) if (request[key] === undefined) delete request[key];
      expect(status(await store.port.submit(request as never))).toBe(400);
    }
    expect(status(await store.port.list({ entity: 'x' as never }))).toBe(400);
    expect(status(await store.port.list({ status: 'x' as never }))).toBe(400);
    expect(status(await store.port.list({ limit: 7 as never }))).toBe(400);
    expect(status(await store.port.list({ cursor: 'basura' }))).toBe(400);
  });

  it('accepts rows as objects and rejects a non-object row', async () => {
    const store = fresh();
    const ok = await store.port.submit({
      entity: 'vehicle',
      mode: 'dry_run',
      rows: [
        {
          economicNumber: 'E-1',
          plate: 'P-1',
          make: 'N',
          model: 'M',
          year: 2022,
          areaId: 'area-norte',
          odometerKm: 5,
        },
      ],
    } as never);
    expect(value<{ job: { validRows: number } }>(ok).job.validRows).toBe(1);
    expect(
      status(await store.port.submit({ entity: 'vehicle', mode: 'dry_run', rows: [1] } as never)),
    ).toBe(400);
  });

  it('reads, filters and pages with uniform 404s', async () => {
    const store = createMockImportStore(env());
    expect(store.snapshot().length).toBeGreaterThan(20);
    const page = value<{ items: { id: string }[]; nextCursor: string | null; total: number }>(
      await store.port.list(),
    );
    expect(page.items).toHaveLength(25);
    const next = value<{ items: unknown[] }>(
      await store.port.list({ cursor: page.nextCursor ?? '' }),
    );
    expect(next.items.length).toBe(page.total - 25);
    expect(value<{ total: number }>(await store.port.list({ status: 'failed' })).total).toBe(1);
    expect(value<{ id: string }>(await store.port.get('imp-001')).id).toBe('imp-001');
    for (const result of [
      await store.port.get('nope'),
      await store.port.rows('nope'),
      await store.port.history('nope'),
    ])
      expect(status(result)).toBe(404);
    expect(status(await store.port.rows('imp-001', { outcome: 'x' as never }))).toBe(400);
    const some = value<{ items: { outcome: string }[] }>(
      await store.port.rows('imp-001', { outcome: 'invalid' }),
    );
    expect(some.items.every((item) => item.outcome === 'invalid')).toBe(true);
    expect(
      value<{ items: unknown[] }>(await store.port.history('imp-002', {})).items.length,
    ).toBeGreaterThan(0);
  });
});

describe('importWritesPii', () => {
  it('is true only for employee files that carry a personal-data column', () => {
    expect(importWritesPii({ entity: 'employee', csv: 'kind,email\ndriver,a' })).toBe(true);
    expect(importWritesPii({ entity: 'employee', csv: 'kind,firstName\ndriver,a' })).toBe(false);
    expect(importWritesPii({ entity: 'vehicle', csv: 'email\na' })).toBe(false);
    expect(importWritesPii({ entity: 'employee', rows: [{ phone: '1' }] })).toBe(true);
    expect(importWritesPii({ entity: 'employee', rows: [{ kind: 'driver' }, 3] })).toBe(false);
    expect(importWritesPii({ entity: 'employee', rows: 'x' })).toBe(false);
    expect(importWritesPii(null)).toBe(false);
  });
});
