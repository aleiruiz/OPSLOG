import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { QueryFailedError, type DataSource } from 'typeorm';
import type { SavedViewRecord } from '../../../domain/saved-views/src/index.js';
import { ListColumnsEntity, SavedViewEntity } from './entities.js';
import { TypeOrmSavedViewStore } from './store.js';

const record = (over: Partial<SavedViewRecord> = {}): SavedViewRecord => ({
  id: 'v1',
  tenantId: 't1',
  ownerId: 'm1',
  module: 'vehicles',
  name: 'Activos',
  nameKey: 'activos',
  filters: { status: 'active' },
  sort: { field: 'folio', direction: 'desc' },
  columns: ['plate'],
  shared: true,
  version: 3,
  createdAt: '2026-10-19T10:00:00.000Z',
  updatedAt: '2026-10-19T11:00:00.000Z',
  ...over,
});

interface Calls {
  find: unknown[];
  findOneBy: unknown[];
  update: unknown[];
  delete: unknown[];
  insert: unknown[];
  upsert: unknown[];
}

function fake(
  options: {
    rows?: SavedViewEntity[];
    owned?: number;
    affected?: number;
    fail?: unknown;
    columns?: ListColumnsEntity | null;
    lockGranted?: number;
  } = {},
) {
  const calls: Calls = { find: [], findOneBy: [], update: [], delete: [], insert: [], upsert: [] };
  const entityOf = (view: SavedViewRecord): SavedViewEntity => ({
    tenantId: view.tenantId,
    id: view.id,
    ownerId: view.ownerId,
    module: view.module,
    name: view.name,
    nameKey: view.nameKey,
    filters: JSON.stringify(view.filters),
    sortField: view.sort?.field ?? null,
    sortDirection: view.sort?.direction ?? null,
    columns: view.columns ? JSON.stringify(view.columns) : null,
    shared: view.shared,
    version: view.version,
    createdAt: new Date(view.createdAt),
    updatedAt: new Date(view.updatedAt),
  });
  const rows = options.rows ?? [entityOf(record())];
  const repository = (target: unknown) => ({
    find: async (query: unknown) => (calls.find.push(query), rows),
    findOneBy: async (where: unknown) => {
      calls.findOneBy.push(where);
      return target === ListColumnsEntity ? (options.columns ?? null) : (rows[0] ?? null);
    },
    update: async (where: unknown, changes: unknown) => {
      if (options.fail) throw options.fail;
      calls.update.push([where, changes]);
      return { affected: options.affected ?? 1 };
    },
    delete: async (where: unknown) => (
      calls.delete.push(where), { affected: options.affected ?? 1 }
    ),
    upsert: async (...args: unknown[]) => void calls.upsert.push(args),
  });
  const queries: string[] = [];
  let active = false;
  const runnerManager = {
    count: async (_entity: unknown, query: unknown) => (calls.find.push(query), options.owned ?? 0),
    insert: async (_entity: unknown, row: unknown) => {
      if (options.fail) throw options.fail;
      calls.insert.push(row);
    },
  };
  const runner = {
    manager: runnerManager,
    get isTransactionActive() {
      return active;
    },
    connect: async () => undefined,
    release: async () => void queries.push('release'),
    startTransaction: async () => void (active = true),
    commitTransaction: async () => void ((active = false), queries.push('commit')),
    rollbackTransaction: async () => void ((active = false), queries.push('rollback')),
    query: async (sql: string) => {
      queries.push(sql.split('(')[0] as string);
      return [{ granted: options.lockGranted ?? 1 }];
    },
  };
  const source = {
    options: { username: 'opslog_views_t1' },
    getRepository: repository,
    createQueryRunner: () => runner,
  } as unknown as DataSource;
  return { source, calls, entityOf, queries };
}

const duplicate = () =>
  new QueryFailedError('INSERT', [], Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' }));

describe('TypeOrmSavedViewStore', () => {
  it('requires the restricted runtime account', () => {
    const { source } = fake();
    (source.options as { username: string }).username = 'root';
    expect(() => new TypeOrmSavedViewStore(source)).toThrow(/restricted/);
  });

  it("lists the views of the module that are the member's or shared, always inside the company", async () => {
    const { source, calls } = fake();
    const [view] = await new TypeOrmSavedViewStore(source).list('t1', 'vehicles', 'm1');
    expect(calls.find[0]).toMatchObject({
      where: [
        { tenantId: 't1', module: 'vehicles', ownerId: 'm1' },
        { tenantId: 't1', module: 'vehicles', shared: true },
      ],
    });
    expect(view).toEqual(record());
  });

  it('reads one view by company and id, and maps a missing one to null', async () => {
    const found = fake();
    expect(await new TypeOrmSavedViewStore(found.source).get('t1', 'v1')).toEqual(record());
    expect(found.calls.findOneBy[0]).toEqual({ tenantId: 't1', id: 'v1' });
    const none = fake({ rows: [] });
    expect(await new TypeOrmSavedViewStore(none.source).get('t1', 'zz')).toBeNull();
  });

  it('reads a view without order, columns or readable filters', async () => {
    const { source, entityOf } = fake();
    const base = entityOf(record());
    const odd = fake({
      rows: [
        { ...base, sortField: 'x', sortDirection: 'sideways', columns: '"nope"', filters: '[1]' },
      ],
    });
    const [view] = await new TypeOrmSavedViewStore(odd.source).list('t1', 'vehicles', 'm1');
    expect(view).toMatchObject({ sort: null, columns: null, filters: {} });
    expect(source).toBeDefined();
  });

  it('creates below the limit, answers limit at it and duplicate on a taken name', async () => {
    const ok = fake({ owned: 49 });
    expect(await new TypeOrmSavedViewStore(ok.source).create(record(), 50)).toBe('created');
    expect(ok.calls.find[0]).toMatchObject({
      where: { tenantId: 't1', ownerId: 'm1', module: 'vehicles' },
    });
    expect(ok.queries).toEqual(['SELECT GET_LOCK', 'commit', 'SELECT RELEASE_LOCK', 'release']);
    expect(ok.calls.insert[0]).toMatchObject({ filters: '{"status":"active"}', shared: true });
    const full = fake({ owned: 50 });
    expect(await new TypeOrmSavedViewStore(full.source).create(record(), 50)).toBe('limit');
    expect(full.calls.insert).toEqual([]);
    expect(full.queries).toEqual(['SELECT GET_LOCK', 'rollback', 'SELECT RELEASE_LOCK', 'release']);
    const busy = fake({ lockGranted: 0 });
    await expect(new TypeOrmSavedViewStore(busy.source).create(record(), 50)).rejects.toThrow(
      /busy/,
    );
    expect(busy.queries).toEqual(['SELECT GET_LOCK', 'release']);
    const taken = fake({ fail: duplicate() });
    expect(await new TypeOrmSavedViewStore(taken.source).create(record(), 50)).toBe('duplicate');
    const broken = fake({ fail: new Error('down') });
    await expect(new TypeOrmSavedViewStore(broken.source).create(record(), 50)).rejects.toThrow(
      'down',
    );
  });

  it('replaces only at the expected version, never touching owner, module or creation date', async () => {
    const ok = fake();
    const store = new TypeOrmSavedViewStore(ok.source);
    expect(await store.replace(record({ sort: null, columns: null }), 3)).toBe('replaced');
    const [where, changes] = ok.calls.update[0] as [object, Record<string, unknown>];
    expect(where).toEqual({ tenantId: 't1', id: 'v1', version: 3 });
    expect(changes).not.toHaveProperty('ownerId');
    expect(changes).not.toHaveProperty('module');
    expect(changes).not.toHaveProperty('createdAt');
    expect(changes).toMatchObject({ sortField: null, columns: null, version: 3 });
    const stale = fake({ affected: 0 });
    expect(await new TypeOrmSavedViewStore(stale.source).replace(record(), 2)).toBe('stale');
    const taken = fake({ fail: duplicate() });
    expect(await new TypeOrmSavedViewStore(taken.source).replace(record(), 3)).toBe('duplicate');
    const broken = fake({ fail: new Error('down') });
    await expect(new TypeOrmSavedViewStore(broken.source).replace(record(), 3)).rejects.toThrow(
      'down',
    );
  });

  it('removes by company and id', async () => {
    const ok = fake();
    expect(await new TypeOrmSavedViewStore(ok.source).remove('t1', 'v1')).toBe(true);
    expect(ok.calls.delete[0]).toEqual({ tenantId: 't1', id: 'v1' });
    const none = fake({ affected: 0 });
    expect(await new TypeOrmSavedViewStore(none.source).remove('t1', 'v1')).toBe(false);
  });

  it('keeps the visible columns per company, member and module', async () => {
    const { source, calls } = fake({
      columns: {
        tenantId: 't1',
        memberId: 'm1',
        module: 'vehicles',
        columns: '["plate","year"]',
        updatedAt: new Date(),
      },
    });
    const store = new TypeOrmSavedViewStore(source);
    expect(await store.getColumns('t1', 'm1', 'vehicles')).toEqual(['plate', 'year']);
    expect(calls.findOneBy[0]).toEqual({ tenantId: 't1', memberId: 'm1', module: 'vehicles' });
    await store.saveColumns('t1', 'm1', 'vehicles', ['plate'], '2026-10-19T10:00:00.000Z');
    await store.saveColumns('t1', 'm1', 'vehicles', null, '2026-10-19T10:00:00.000Z');
    const [first, second] = calls.upsert as [
      [Record<string, unknown>, string[]],
      [Record<string, unknown>, string[]],
    ];
    expect(first[0]).toMatchObject({ tenantId: 't1', memberId: 'm1', columns: '["plate"]' });
    expect(first[1]).toEqual(['tenantId', 'memberId', 'module']);
    expect(second[0]).toMatchObject({ columns: null });
    const empty = fake();
    expect(
      await new TypeOrmSavedViewStore(empty.source).getColumns('t1', 'm1', 'vehicles'),
    ).toBeNull();
  });
});
