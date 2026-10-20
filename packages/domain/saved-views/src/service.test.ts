import { describe, expect, it } from 'vitest';
import { SavedViewError, type SavedViewErrorCode } from './errors.js';
import { InMemorySavedViewStore } from './memory-store.js';
import { SavedViewService } from './service.js';
import { catalog, viewer } from './test-support.js';

const A = 'company-a';
const B = 'company-b';

function setup() {
  let counter = 0;
  const store = new InMemorySavedViewStore();
  const service = new SavedViewService(store, catalog, {
    now: () => new Date('2026-10-19T12:00:00.000Z'),
    newId: () => `view-${++counter}`,
  });
  return { store, service };
}

async function code(work: Promise<unknown>): Promise<SavedViewErrorCode | 'no error'> {
  try {
    await work;
    return 'no error';
  } catch (error) {
    if (error instanceof SavedViewError) return error.code;
    throw error;
  }
}

const ana = viewer('ana');
const luis = viewer('luis');
const boss = viewer('boss', 'manage_config');

describe('SavedViewService.create', () => {
  it('stores a view for the owner with a normalized name and version 1', async () => {
    const { service } = setup();
    const view = await service.create(A, ana, 'maintenance', {
      name: '  Abiertas   hoy ',
      filters: { status: 'open' },
      sort: { field: 'folio', direction: 'desc' },
      columns: ['folio', 'status'],
    });
    expect(view).toMatchObject({
      id: 'view-1',
      name: 'Abiertas hoy',
      shared: false,
      mine: true,
      canEdit: true,
      version: 1,
      filters: { status: 'open' },
      sort: { field: 'folio', direction: 'desc' },
      columns: ['folio', 'status'],
      dropped: [],
    });
  });

  it('rejects what the allowlist does not hold', async () => {
    const { service } = setup();
    const bad = (input: Record<string, unknown>) =>
      code(service.create(A, ana, 'maintenance', { name: 'x', ...input }));
    expect(await bad({ filters: { nope: '1' } })).toBe('invalid_input');
    expect(await bad({ filters: { status: 'wrong' } })).toBe('invalid_input');
    expect(await bad({ filters: { status: 3 } })).toBe('invalid_input');
    expect(await bad({ filters: ['status'] })).toBe('invalid_input');
    expect(await bad({ sort: { field: 'cost', direction: 'asc' } })).toBe('invalid_input');
    expect(await bad({ sort: { field: 'folio', direction: 'up' } })).toBe('invalid_input');
    expect(await bad({ sort: { field: 'folio', direction: 'asc', extra: 1 } })).toBe(
      'invalid_input',
    );
    expect(await bad({ sort: 'folio' })).toBe('invalid_input');
    expect(await bad({ columns: [] })).toBe('invalid_input');
    expect(await bad({ columns: ['folio', 'folio'] })).toBe('invalid_input');
    expect(await bad({ columns: ['nope'] })).toBe('invalid_input');
    expect(await bad({ columns: 'folio' })).toBe('invalid_input');
    expect(await bad({ columns: ['folio', 'status', 'cost', 'extra'] })).toBe('invalid_input');
    expect(await bad({ shared: 'yes' })).toBe('invalid_input');
    expect(await code(service.create(A, ana, 'maintenance', { name: '' }))).toBe('invalid_input');
    expect(await code(service.create(A, ana, 'maintenance', { name: 'a'.repeat(81) }))).toBe(
      'invalid_input',
    );
    expect(await code(service.create(A, ana, 'maintenance', { name: 'a\u0007b' }))).toBe(
      'invalid_input',
    );
    expect(await code(service.create(A, ana, 'maintenance', { name: 7 }))).toBe('invalid_input');
    expect(await code(service.create(A, ana, 'unknown', { name: 'x' }))).toBe('invalid_input');
    expect(await code(service.create(A, ana, 7, { name: 'x' }))).toBe('invalid_input');
  });

  it('forbids a filter or a column the writer cannot use, and a list the writer cannot open', async () => {
    const { service } = setup();
    expect(
      await code(service.create(A, ana, 'maintenance', { name: 'x', filters: { costFrom: '5' } })),
    ).toBe('forbidden');
    expect(
      await code(service.create(A, ana, 'maintenance', { name: 'x', columns: ['folio', 'cost'] })),
    ).toBe('forbidden');
    expect(await code(service.create(A, ana, 'incidents', { name: 'x' }))).toBe('forbidden');
    const costly = viewer('ana', 'view_costs');
    const view = await service.create(A, costly, 'maintenance', {
      name: 'x',
      filters: { costFrom: '5' },
    });
    expect(view.filters).toEqual({ costFrom: '5' });
  });

  it('refuses a second view with the same name (any case) and the 51st view', async () => {
    const { service } = setup();
    await service.create(A, ana, 'maintenance', { name: 'Abiertas' });
    expect(await code(service.create(A, ana, 'maintenance', { name: 'ABIERTAS' }))).toBe(
      'duplicate',
    );
    // Another member, another module and another company may reuse the name.
    await service.create(A, luis, 'maintenance', { name: 'Abiertas' });
    await service.create(B, ana, 'maintenance', { name: 'Abiertas' });
    for (let i = 1; i < 50; i += 1) await service.create(A, ana, 'maintenance', { name: `v${i}` });
    expect(await code(service.create(A, ana, 'maintenance', { name: 'one more' }))).toBe(
      'limit_reached',
    );
  });
});

describe('SavedViewService.list', () => {
  it('shows the reader their own views and the shared ones of the company, never another company', async () => {
    const { service } = setup();
    await service.create(A, ana, 'maintenance', { name: 'Privada de Ana' });
    await service.create(A, ana, 'maintenance', { name: 'Compartida de Ana', shared: true });
    await service.create(A, luis, 'maintenance', { name: 'Privada de Luis' });
    await service.create(B, luis, 'maintenance', { name: 'Compartida de B', shared: true });
    const names = async (tenant: string, who: typeof ana) =>
      (await service.list(tenant, who, 'maintenance')).map((v) => v.name);
    expect(await names(A, luis)).toEqual(['Compartida de Ana', 'Privada de Luis']);
    expect(await names(A, ana)).toEqual(['Compartida de Ana', 'Privada de Ana']);
    expect(await names(B, ana)).toEqual(['Compartida de B']);
    const seen = (await service.list(A, luis, 'maintenance')).find(
      (v) => v.name === 'Compartida de Ana',
    );
    expect(seen).toMatchObject({ mine: false, canEdit: false });
    expect(JSON.stringify(seen)).not.toContain('ana"');
  });

  it('drops, with a notice, what the reader cannot use from a shared view', async () => {
    const { service } = setup();
    const owner = viewer('owner', 'view_costs');
    await service.create(A, owner, 'maintenance', {
      name: 'Costosas',
      shared: true,
      filters: { status: 'open', costFrom: '1000' },
      columns: ['folio', 'cost'],
    });
    const [seen] = await service.list(A, ana, 'maintenance');
    expect(seen?.filters).toEqual({ status: 'open' });
    expect(seen?.columns).toEqual(['folio']);
    expect(seen?.dropped).toEqual([
      { kind: 'filter', key: 'costFrom', label: 'Costo desde', reason: 'permission' },
      { kind: 'column', key: 'cost', label: 'Costo', reason: 'permission' },
    ]);
    const [owned] = await service.list(A, owner, 'maintenance');
    expect(owned?.dropped).toEqual([]);
    expect(owned?.filters).toEqual({ status: 'open', costFrom: '1000' });
  });

  it('drops what the allowlist no longer holds', async () => {
    const { service, store } = setup();
    await store.create(
      {
        id: 'old',
        tenantId: A,
        ownerId: 'ana',
        module: 'maintenance',
        name: 'Vieja',
        nameKey: 'vieja',
        shared: false,
        filters: { gone: '1', status: 'weird' },
        sort: { field: 'removed', direction: 'asc' },
        columns: ['removed'],
        version: 1,
        createdAt: 'x',
        updatedAt: 'x',
      },
      50,
    );
    const [view] = await service.list(A, ana, 'maintenance');
    expect(view).toMatchObject({ filters: {}, sort: null, columns: null });
    expect(view?.dropped.map((d) => `${d.kind}:${d.key}:${d.reason}`)).toEqual([
      'filter:gone:invalid',
      'filter:status:invalid',
      'sort:removed:invalid',
      'column:removed:invalid',
    ]);
  });

  it('needs the permission of the list and a known module', async () => {
    const { service } = setup();
    expect(await code(service.list(A, ana, 'incidents'))).toBe('forbidden');
    expect(await code(service.list(A, ana, 'nope'))).toBe('invalid_input');
  });
});

describe('SavedViewService.update and remove', () => {
  it('lets the owner edit with the current version and bumps it', async () => {
    const { service } = setup();
    const created = await service.create(A, ana, 'maintenance', {
      name: 'Uno',
      filters: { status: 'open' },
    });
    const next = await service.update(A, ana, created.id, {
      version: 1,
      name: 'Dos',
      shared: true,
      filters: { status: 'closed' },
      sort: { field: 'folio', direction: 'asc' },
      columns: ['folio'],
    });
    expect(next).toMatchObject({
      name: 'Dos',
      shared: true,
      version: 2,
      filters: { status: 'closed' },
      sort: { field: 'folio', direction: 'asc' },
      columns: ['folio'],
    });
    const renamed = await service.update(A, ana, created.id, { version: 2, name: 'Tres' });
    expect(renamed).toMatchObject({ name: 'Tres', filters: { status: 'closed' }, version: 3 });
  });

  it('answers concurrent versions with stale_version and a taken name with duplicate', async () => {
    const { service } = setup();
    const one = await service.create(A, ana, 'maintenance', { name: 'Uno' });
    await service.create(A, ana, 'maintenance', { name: 'Dos' });
    await service.update(A, ana, one.id, { version: 1, shared: true });
    expect(await code(service.update(A, ana, one.id, { version: 1, shared: false }))).toBe(
      'stale_version',
    );
    expect(await code(service.update(A, ana, one.id, { version: 2, name: 'dos' }))).toBe(
      'duplicate',
    );
    expect(await code(service.update(A, ana, one.id, { name: 'x' }))).toBe('invalid_input');
    expect(await code(service.update(A, ana, one.id, { version: 0 }))).toBe('invalid_input');
    expect(await code(service.update(A, ana, 'bad id!', { version: 1 }))).toBe('invalid_input');
    expect(await code(service.update(A, ana, 5, { version: 1 }))).toBe('invalid_input');
  });

  it('hides the private view of another member (404) and the view of another company', async () => {
    const { service } = setup();
    const mine = await service.create(A, ana, 'maintenance', { name: 'Privada' });
    expect(await code(service.update(A, luis, mine.id, { version: 1, name: 'x' }))).toBe(
      'not_found',
    );
    expect(await code(service.remove(A, boss, mine.id))).toBe('not_found');
    expect(await code(service.remove(B, ana, mine.id))).toBe('not_found');
    expect(await code(service.remove(A, ana, 'missing'))).toBe('not_found');
  });

  it('forbids editing a shared view of another member without manage_config', async () => {
    const { service } = setup();
    const shared = await service.create(A, ana, 'maintenance', { name: 'Equipo', shared: true });
    expect(await code(service.update(A, luis, shared.id, { version: 1, name: 'x' }))).toBe(
      'forbidden',
    );
    expect(await code(service.remove(A, luis, shared.id))).toBe('forbidden');
    const edited = await service.update(A, boss, shared.id, { version: 1, name: 'Equipo 2' });
    expect(edited).toMatchObject({ name: 'Equipo 2', mine: false, canEdit: true });
    await service.remove(A, boss, shared.id);
    expect(await service.list(A, ana, 'maintenance')).toEqual([]);
  });

  it('removes the own view', async () => {
    const { service } = setup();
    const view = await service.create(A, ana, 'maintenance', { name: 'Uno' });
    await service.remove(A, ana, view.id);
    expect(await service.list(A, ana, 'maintenance')).toEqual([]);
  });

  it('does not let a reader without the list permission touch its views', async () => {
    const { service, store } = setup();
    await store.create(
      {
        id: 's1',
        tenantId: A,
        ownerId: 'ana',
        module: 'incidents',
        name: 'S',
        nameKey: 's',
        shared: true,
        filters: {},
        sort: null,
        columns: null,
        version: 1,
        createdAt: 'x',
        updatedAt: 'x',
      },
      50,
    );
    expect(await code(service.remove(A, luis, 's1'))).toBe('forbidden');
  });

  it('lets the owner delete, but not edit, their own view after losing the list permission', async () => {
    const { service, store } = setup();
    await store.create(
      {
        id: 'o1',
        tenantId: A,
        ownerId: 'luis',
        module: 'incidents',
        name: 'O',
        nameKey: 'o',
        shared: false,
        filters: {},
        sort: null,
        columns: null,
        version: 1,
        createdAt: 'x',
        updatedAt: 'x',
      },
      50,
    );
    expect(await code(service.update(A, luis, 'o1', { version: 1, name: 'P' }))).toBe('forbidden');
    await service.remove(A, luis, 'o1');
    expect(await store.get(A, 'o1')).toBeNull();
  });
});

describe('SavedViewService columns', () => {
  it('keeps the columns per member, company and module', async () => {
    const { service } = setup();
    expect(await service.columns(A, ana, 'maintenance')).toEqual({
      module: 'maintenance',
      columns: null,
      dropped: [],
    });
    expect(await service.saveColumns(A, ana, 'maintenance', ['status', 'folio'])).toEqual({
      module: 'maintenance',
      columns: ['status', 'folio'],
      dropped: [],
    });
    expect((await service.columns(A, ana, 'maintenance')).columns).toEqual(['status', 'folio']);
    expect((await service.columns(A, luis, 'maintenance')).columns).toBeNull();
    expect((await service.columns(B, ana, 'maintenance')).columns).toBeNull();
    await service.saveColumns(A, ana, 'maintenance', null);
    expect((await service.columns(A, ana, 'maintenance')).columns).toBeNull();
  });

  it('rejects unknown or forbidden columns and drops those revoked since', async () => {
    const { service } = setup();
    expect(await code(service.saveColumns(A, ana, 'maintenance', ['zzz']))).toBe('invalid_input');
    expect(await code(service.saveColumns(A, ana, 'maintenance', ['cost']))).toBe('forbidden');
    const costly = viewer('ana', 'view_costs');
    await service.saveColumns(A, costly, 'maintenance', ['folio', 'cost']);
    const later = await service.columns(A, ana, 'maintenance');
    expect(later.columns).toEqual(['folio']);
    expect(later.dropped).toEqual([
      { kind: 'column', key: 'cost', label: 'Costo', reason: 'permission' },
    ]);
  });
});

describe('SavedViewService defaults', () => {
  it('uses the real clock and random ids when none are injected', async () => {
    const service = new SavedViewService(new InMemorySavedViewStore(), catalog);
    const view = await service.create(A, ana, 'maintenance', { name: 'Uno' });
    expect(view.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Date.now() - Date.parse(view.updatedAt)).toBeLessThan(10_000);
  });
});
