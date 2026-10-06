import { describe, expect, it } from 'vitest';
import { makeArea } from '../areas/fixtures';
import { createMockAreaStore, demoMockAreas } from './mockAreas';
import type { Area, Result } from './types';

let vehicles: Record<string, number> = {};
const members = new Set(['user-admin', 'user-dispatch']);
const store = (seed?: readonly Area[]) => {
  vehicles = {};
  return createMockAreaStore(
    {
      liveVehicles: (id) => vehicles[id] ?? 0,
      isMember: (id) => members.has(id),
      actorId: () => 'user-admin',
    },
    seed,
  );
};
const code = <T>(result: Result<T>) => (result.ok ? 'ok' : `${result.error.status} ${result.error.code}`);
const field = <T>(result: Result<T>) => (result.ok ? null : result.error.fieldErrors?.[0]?.field);
const value = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`unexpected ${result.error.code}`);
  return result.value;
};
const bad = { name: '' } as never;

describe('mock areas: reads', () => {
  it('lists active areas by name, with filters and cursor pages, and a uniform 400', async () => {
    const { port } = store();
    const all = value(await port.list({ limit: 100 }));
    expect(all.total).toBe(12);
    expect(all.items.map((a) => a.name).slice(0, 3)).toEqual(['Base Apodaca', 'Base Cuautitlán', 'Centro']);
    expect(value(await port.list({ includeInactive: 'true', limit: 100 })).total).toBe(13);
    expect(value(await port.list({ parentId: 'root' })).items.map((a) => a.id).sort()).toEqual([
      'area-centro',
      'area-norte',
      'area-sur',
    ]);
    expect(value(await port.list({ parentId: 'area-norte-mty', includeInactive: 'true' })).total).toBe(2);
    const first = value(await port.list({ limit: 25 }));
    expect(first.nextCursor).toBeNull();
    const small = store(Array.from({ length: 30 }, (_, i) => makeArea({ id: `a${i}`, name: `A${String(i).padStart(2, '0')}`, code: null, parentId: null })));
    const page1 = value(await small.port.list({ limit: 25 }));
    expect(page1.items).toHaveLength(25);
    const page2 = value(await small.port.list({ limit: 25, cursor: page1.nextCursor as string }));
    expect(page2.items).toHaveLength(5);
    for (const query of [
      { limit: 7 as never },
      { cursor: 'zzz' },
      { parentId: 'no valido!' },
      { includeInactive: 'quizas' as never },
    ])
      expect(code(await port.list(query))).toBe('400 bad_request');
  });

  it('gets an area with live resource counts, and a uniform 404', async () => {
    const mock = store();
    vehicles['area-norte'] = 3;
    mock.setPeople('area-norte', 2);
    expect(value(await mock.port.get('area-norte')).resourceCounts).toEqual({ vehicles: 3, people: 2 });
    expect(value(await mock.port.get('area-sur')).resourceCounts).toEqual({ vehicles: 0, people: 0 });
    expect(code(await mock.port.get('x'))).toBe('404 not_found');
  });

  it('pages the history newest first and starts from a believable one', async () => {
    const mock = store();
    const first = value(await mock.port.history('area-norte'));
    expect(first.items).toHaveLength(25);
    expect(first.items[0]?.version).toBe(28);
    const second = value(await mock.port.history('area-norte', { cursor: first.nextCursor as string }));
    expect(second.items.map((e) => e.version)).toEqual([3, 2, 1]);
    expect(second.items[2]).toMatchObject({ action: 'created', fromParentId: null });
    const closed = value(await mock.port.history('area-mty-guadalupe'));
    expect(closed.items[0]).toMatchObject({ action: 'deactivated', fields: [] });
    expect(code(await mock.port.history('x'))).toBe('404 not_found');
    expect(code(await mock.port.history('area-norte', { limit: 3 as never }))).toBe('400 bad_request');
  });
});

describe('mock areas: create', () => {
  it('creates a root area and a child, normalizing values and recording the history', async () => {
    const mock = store();
    const root = value(await mock.port.create({ name: '  Oeste  ', code: 'oes', responsibleIds: ['user-dispatch'] }));
    expect(root).toMatchObject({ name: 'Oeste', code: 'OES', depth: 1, parentId: null, version: 1, active: true });
    const child = value(await mock.port.create({ name: 'Base', parentId: root.id }));
    expect(child).toMatchObject({ depth: 2, parentId: root.id, code: null, responsibleIds: [] });
    expect(value(await mock.port.history(child.id)).items[0]).toMatchObject({
      action: 'created',
      toParentId: root.id,
      actorId: 'user-admin',
    });
  });

  it('answers 400 for malformed input and 422 for hierarchy and responsibles', async () => {
    const { port } = store();
    for (const input of [
      bad,
      { code: 'X' } as never,
      { name: 'a', extra: 1 } as never,
      { name: 'a', code: '!!' } as never,
      { name: 'a', code: 7 } as never,
      { name: 'a', parentId: 7 } as never,
      { name: 'a', responsibleIds: 'x' } as never,
      { name: 'a', responsibleIds: [1] } as never,
      { name: 'a', responsibleIds: Array.from({ length: 21 }, (_, i) => `u${i}`) } as never,
      { name: 7 } as never,
    ])
      expect(code(await port.create(input))).toBe('400 bad_request');
    expect(code(await port.create({ name: 'x', parentId: 'no-existe' }))).toBe('422 invalid_hierarchy');
    expect(code(await port.create({ name: 'x', parentId: 'area-mty-guadalupe' }))).toBe('422 invalid_hierarchy');
    expect(code(await port.create({ name: 'x', parentId: 'area-apodaca-taller' }))).toBe('422 invalid_hierarchy');
    expect(code(await port.create({ name: 'x', responsibleIds: ['desconocido'] }))).toBe('422 invalid_responsible');
  });

  it('rejects a repeated sibling name (any case) and a repeated code, naming the field', async () => {
    const { port } = store();
    expect(field(await port.create({ name: 'norte' }))).toBe('name');
    expect(code(await port.create({ name: 'Norte', parentId: 'area-sur' }))).toBe('ok');
    expect(field(await port.create({ name: 'Nuevo', code: 'nte' }))).toBe('code');
    expect(code(await port.create({ name: 'Otro', code: null }))).toBe('ok');
  });
});

describe('mock areas: update and move', () => {
  it('edits fields in place, bumps the version once and records which fields changed', async () => {
    const mock = store();
    const area = value(await mock.port.get('area-sur'));
    const next = value(
      await mock.port.update('area-sur', {
        version: area.version,
        name: 'Sureste',
        code: null,
        responsibleIds: ['user-dispatch', 'user-admin'],
      }),
    );
    expect(next).toMatchObject({ name: 'Sureste', code: null, version: area.version + 1 });
    expect(next.responsibleIds).toEqual(['user-admin', 'user-dispatch']);
    expect(value(await mock.port.history('area-sur')).items[0]).toMatchObject({
      action: 'updated',
      fields: ['name', 'code', 'responsibles'],
    });
    // A no-op keeps the version and the history.
    const same = value(await mock.port.update('area-sur', { version: next.version, name: 'Sureste' }));
    expect(same.version).toBe(next.version);
    expect(value(await mock.port.history('area-sur')).total).toBe(next.version);
  });

  it('refuses stale versions, inactive areas, unknown areas and malformed patches', async () => {
    const { port } = store();
    expect(code(await port.update('area-sur', { version: 99, name: 'x' }))).toBe('409 stale_version');
    expect(code(await port.update('area-mty-guadalupe', { version: 5, name: 'x' }))).toBe('409 immutable');
    expect(code(await port.update('x', { version: 1, name: 'x' }))).toBe('404 not_found');
    expect(code(await port.update('area-sur', { version: 1 }))).toBe('400 bad_request');
    expect(code(await port.update('area-sur', { version: 0, name: 'x' } as never))).toBe('400 bad_request');
    expect(code(await port.update('area-sur', { version: 1, nombre: 'x' } as never))).toBe('400 bad_request');
  });

  it('rejects duplicates on rename, on code and when a move lands among a same-named sibling', async () => {
    const { port } = store();
    expect(field(await port.update('area-sur', { version: 1, name: 'centro' }))).toBe('name');
    expect(field(await port.update('area-sur', { version: 1, code: 'NTE' }))).toBe('code');
    expect(code(await port.update('area-sur', { version: 1, code: 'SUR' }))).toBe('ok');
    const made = value(await port.create({ name: 'Monterrey', parentId: 'area-sur' }));
    expect(made.parentId).toBe('area-sur');
    // "Monterrey" already exists under Norte: moving this one there collides.
    expect(field(await port.update(made.id, { version: 1, parentId: 'area-norte' }))).toBe('name');
  });

  it('moves a subtree, shifting the depth of every descendant', async () => {
    const mock = store();
    const monterrey = value(await mock.port.get('area-norte-mty'));
    const moved = value(await mock.port.update('area-norte-mty', { version: monterrey.version, parentId: null }));
    expect(moved).toMatchObject({ parentId: null, depth: 1 });
    const depths = Object.fromEntries(mock.snapshot().map((a) => [a.id, a.depth]));
    expect(depths['area-mty-apodaca']).toBe(2);
    expect(depths['area-apodaca-taller']).toBe(3);
    expect(value(await mock.port.history('area-norte-mty')).items[0]).toMatchObject({
      fields: ['parent'],
      fromParentId: 'area-norte',
      toParentId: null,
    });
  });

  it('refuses cycles, deep placements, unknown or inactive parents and unknown responsibles', async () => {
    const { port } = store();
    const v = (await port.get('area-norte-mty')) as { ok: true; value: Area };
    const version = v.value.version;
    expect(code(await port.update('area-norte-mty', { version, parentId: 'area-norte-mty' }))).toBe('422 invalid_hierarchy');
    expect(code(await port.update('area-norte-mty', { version, parentId: 'area-apodaca-taller' }))).toBe('422 invalid_hierarchy');
    expect(code(await port.update('area-norte-mty', { version, parentId: 'area-sur-mer' }))).toBe('422 invalid_hierarchy');
    expect(code(await port.update('area-norte-mty', { version, parentId: 'x' }))).toBe('422 invalid_hierarchy');
    expect(code(await port.update('area-sur-mer', { version: 1, parentId: 'area-mty-guadalupe' }))).toBe('422 invalid_hierarchy');
    expect(code(await port.update('area-sur', { version: 1, responsibleIds: ['otro'] }))).toBe('422 invalid_responsible');
    // Already-assigned responsibles are not revalidated, so a departed member can always be removed.
    members.delete('user-admin');
    expect(code(await port.update('area-norte', { version: 28, responsibleIds: ['user-admin', 'user-dispatch'] }))).toBe('ok');
    members.add('user-admin');
  });
});

describe('mock areas: deactivate and activate', () => {
  it('blocks deactivation by sub-areas, then vehicles, then people, and names the kind', async () => {
    const mock = store();
    const norte = value(await mock.port.get('area-norte'));
    expect(field(await mock.port.deactivate('area-norte', norte.version))).toBe('sub_areas');
    expect(code(await mock.port.deactivate('area-norte', norte.version))).toBe('409 area_in_use');
    vehicles['area-sur-mer'] = 2;
    expect(field(await mock.port.deactivate('area-sur-mer', 1))).toBe('vehicles');
    vehicles['area-sur-mer'] = 0;
    mock.setPeople('area-sur-mer', 1);
    expect(field(await mock.port.deactivate('area-sur-mer', 1))).toBe('people');
    mock.setPeople('area-sur-mer', 0);
    const done = value(await mock.port.deactivate('area-sur-mer', 1));
    expect(done).toMatchObject({ active: false, version: 2 });
    expect(done.deactivatedAt).not.toBeNull();
    expect(value(await mock.port.history('area-sur-mer')).items[0]).toMatchObject({ action: 'deactivated' });
  });

  it('answers 404, 400, 409 stale and 409 invalid_transition', async () => {
    const { port } = store();
    expect(code(await port.deactivate('x', 1))).toBe('404 not_found');
    expect(code(await port.deactivate('area-sur', 0))).toBe('400 bad_request');
    expect(code(await port.deactivate('area-sur', 9))).toBe('409 stale_version');
    expect(code(await port.deactivate('area-mty-guadalupe', 5))).toBe('409 invalid_transition');
    expect(code(await port.activate('x', 1))).toBe('404 not_found');
    expect(code(await port.activate('area-sur', 0))).toBe('400 bad_request');
    expect(code(await port.activate('area-sur', 9))).toBe('409 stale_version');
    expect(code(await port.activate('area-sur', 1))).toBe('409 invalid_transition');
  });

  it('activates an inactive area only under an active parent', async () => {
    const mock = store();
    const activated = value(await mock.port.activate('area-mty-guadalupe', 5));
    expect(activated).toMatchObject({ active: true, deactivatedAt: null, version: 6 });
    expect(value(await mock.port.history('area-mty-guadalupe')).items[0]).toMatchObject({ action: 'activated' });
    mock.deactivateExternally('area-mty-guadalupe');
    mock.deactivateExternally('area-norte-mty');
    // Monterrey is inactive now (a test control skips the rules): its child cannot come back first.
    const child = value(await mock.port.get('area-mty-guadalupe'));
    expect(code(await mock.port.activate('area-mty-guadalupe', child.version))).toBe('422 invalid_hierarchy');
  });

  it('simulates other actors: a rename moves the version on and ignores unknown ids', async () => {
    const mock = store();
    mock.changeExternally('area-sur', { name: 'Sur 2' });
    mock.changeExternally('x', { name: 'nada' });
    mock.deactivateExternally('x');
    expect(mock.snapshot().find((a) => a.id === 'area-sur')).toMatchObject({ name: 'Sur 2', version: 2 });
    expect(code(await mock.port.update('area-sur', { version: 1, name: 'Mío' }))).toBe('409 stale_version');
    expect(value(await mock.port.history('area-sur')).items[0]).toMatchObject({ actorId: 'user-dispatch' });
  });

  it('starts with the demo tree when no seed is given', () => {
    expect(demoMockAreas().find((a) => a.id === 'area-norte')?.version).toBe(28);
    expect(store([]).snapshot()).toEqual([]);
  });
});
