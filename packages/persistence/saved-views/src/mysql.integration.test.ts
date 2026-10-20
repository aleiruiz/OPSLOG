import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SavedViewError,
  SavedViewService,
  type SavedViewErrorCode,
} from '../../../domain/saved-views/src/index.js';
import { catalog, viewer } from '../../../domain/saved-views/src/test-support.js';
import { SAVED_VIEW_TABLES } from './entities.js';
import { TypeOrmSavedViewStore } from './store.js';
import {
  adminUrl,
  startSavedViewsDatabase,
  type SavedViewsDatabase,
} from './test-support/mysql.js';

const suite = adminUrl ? describe : describe.skip;
const A = 'tenant-a';
const B = 'tenant-b';

async function code(work: Promise<unknown>): Promise<SavedViewErrorCode | 'no error'> {
  try {
    await work;
    return 'no error';
  } catch (error) {
    if (error instanceof SavedViewError) return error.code;
    throw error;
  }
}

suite('saved views on MySQL', () => {
  let db: SavedViewsDatabase;
  let service: SavedViewService;
  let store: TypeOrmSavedViewStore;
  const ana = viewer('ana');
  const luis = viewer('luis');
  const boss = viewer('boss', 'manage_config');

  beforeAll(async () => {
    db = await startSavedViewsDatabase('views');
    store = new TypeOrmSavedViewStore(await db.openRuntime());
    service = new SavedViewService(store, catalog);
  }, 60_000);
  afterAll(async () => {
    await db.close();
  }, 30_000);

  it('keeps views per company: the same names and ids in A and B never meet', async () => {
    const a = await service.create(A, ana, 'maintenance', {
      name: 'Abiertas',
      shared: true,
      filters: { status: 'open' },
      sort: { field: 'folio', direction: 'desc' },
      columns: ['folio', 'status'],
    });
    const b = await service.create(B, ana, 'maintenance', { name: 'Abiertas', shared: true });
    expect(await service.list(A, luis, 'maintenance')).toEqual([
      expect.objectContaining({ id: a.id }),
    ]);
    expect((await service.list(B, luis, 'maintenance')).map((v) => v.id)).toEqual([b.id]);
    // A view of B opened with the id in A does not exist.
    expect(await code(service.update(A, ana, b.id, { version: 1, name: 'x' }))).toBe('not_found');
    expect(await code(service.remove(A, boss, b.id))).toBe('not_found');
    const [read] = await service.list(A, ana, 'maintenance');
    expect(read).toMatchObject({
      name: 'Abiertas',
      shared: true,
      filters: { status: 'open' },
      sort: { field: 'folio', direction: 'desc' },
      columns: ['folio', 'status'],
      version: 1,
    });
  });

  it('applies the privacy and edit rules of private and shared views', async () => {
    const mine = await service.create(A, ana, 'maintenance', { name: 'Solo mía' });
    expect((await service.list(A, luis, 'maintenance')).map((v) => v.name)).not.toContain(
      'Solo mía',
    );
    expect(await code(service.update(A, luis, mine.id, { version: 1, name: 'x' }))).toBe(
      'not_found',
    );
    const shared = await service.update(A, ana, mine.id, { version: 1, shared: true });
    expect(await code(service.update(A, luis, shared.id, { version: 2, name: 'x' }))).toBe(
      'forbidden',
    );
    const managed = await service.update(A, boss, shared.id, { version: 2, name: 'Del equipo' });
    expect(managed.version).toBe(3);
    await service.remove(A, boss, shared.id);
  });

  it('answers concurrent edits with one winner and a 409 for the rest', async () => {
    const view = await service.create(A, ana, 'maintenance', { name: 'Carrera' });
    const outcomes = await Promise.all(
      ['uno', 'dos', 'tres', 'cuatro'].map((name) =>
        code(service.update(A, ana, view.id, { version: 1, name })),
      ),
    );
    expect(outcomes.filter((outcome) => outcome === 'no error')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'stale_version')).toHaveLength(3);
  });

  it('refuses a repeated name in any case and the 51st view, also when created at once', async () => {
    await service.create(A, luis, 'maintenance', { name: 'Única' });
    expect(await code(service.create(A, luis, 'maintenance', { name: 'ÚNICA' }))).toBe('duplicate');
    const created = await Promise.all(
      Array.from({ length: 60 }, (_, index) =>
        code(service.create(A, boss, 'maintenance', { name: `v${index}` })),
      ),
    );
    expect(created.filter((outcome) => outcome === 'no error')).toHaveLength(50);
    expect(created.filter((outcome) => outcome === 'limit_reached')).toHaveLength(10);
    expect(
      await db.rows<{ n: number }>(
        `SELECT COUNT(*) AS n FROM \`${SAVED_VIEW_TABLES.views}\` WHERE company_id = ? AND owner_id = ?`,
        [A, 'boss'],
      ),
    ).toEqual([{ n: 50 }]);
  });

  it('keeps the visible columns per member and company', async () => {
    await service.saveColumns(A, ana, 'maintenance', ['status', 'folio']);
    await service.saveColumns(A, ana, 'maintenance', ['folio']);
    expect((await service.columns(A, ana, 'maintenance')).columns).toEqual(['folio']);
    expect((await service.columns(A, luis, 'maintenance')).columns).toBeNull();
    expect((await service.columns(B, ana, 'maintenance')).columns).toBeNull();
    await service.saveColumns(A, ana, 'maintenance', null);
    expect((await service.columns(A, ana, 'maintenance')).columns).toBeNull();
  });

  it('enforces the module and sort checks at the database too', async () => {
    const insert = (module: string, direction: string | null) =>
      db.rows(
        `INSERT INTO \`${SAVED_VIEW_TABLES.views}\` (company_id,id,owner_id,module,name,name_key,filters,sort_direction,shared,version,created_at,updated_at) VALUES ('x',UUID(),'o',?,'n',UUID(),'{}',?,0,1,NOW(6),NOW(6))`,
        [module, direction],
      );
    await expect(insert('nope', null)).rejects.toThrow();
    await expect(insert('vehicles', 'sideways')).rejects.toThrow();
    await expect(insert('vehicles', 'asc')).resolves.toBeDefined();
  });
});
