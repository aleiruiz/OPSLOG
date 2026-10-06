import { describe, expect, it } from 'vitest';
import {
  AREA_ACTIONS,
  AREA_FIELDS,
  AREA_INPUT_FIELDS,
  AreaError,
  AreaService,
  InMemoryAreaStore,
  MAX_AREA_DEPTH,
  MAX_RESPONSIBLES,
  NO_RESOURCES,
  applyActive,
  applyPatch,
  changedFields,
  historyEntry,
  isAreaAction,
  isAreaField,
  nameKey,
  newArea,
  normalizeCode,
  normalizeName,
  normalizeResponsibles,
  parseAreaPatch,
  parseNewArea,
  placementDepth,
  requireOpaqueId,
  requireVersion,
  type Area,
  type AreaMemberDirectory,
  type AreaResourceCounter,
  type AreaStore,
} from './index.js';

const NOW = new Date('2026-10-06T12:00:00.000Z');
const LATER = new Date('2026-10-07T12:00:00.000Z');
const A = 'tenant-a';
const B = 'tenant-b';
const ACTOR = 'user-11111111-1111-4111-8111-111111111111';

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof AreaError ? error.code : 'other';
  }
  return undefined;
};
const rejection = async (promise: Promise<unknown>): Promise<AreaError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AreaError) return error;
    throw error;
  }
  throw new Error('expected the promise to reject');
};

function setup(
  options: {
    store?: AreaStore;
    vehicles?: AreaResourceCounter;
    people?: AreaResourceCounter;
    members?: AreaMemberDirectory;
  } = {},
) {
  let ids = 0;
  const store = options.store ?? new InMemoryAreaStore();
  const svc = new AreaService(store, {
    now: () => NOW,
    newId: () => `id-${(ids += 1)}`,
    resources: {
      vehicles: options.vehicles ?? NO_RESOURCES,
      people: options.people ?? NO_RESOURCES,
    },
    ...(options.members ? { members: options.members } : {}),
  });
  return { store, svc };
}

/** Builds a chain root > l2 > l3 > l4 and returns the ids by level. */
async function chain(svc: AreaService, tenant = A) {
  const root = await svc.create(tenant, ACTOR, { name: 'Pais' });
  const l2 = await svc.create(tenant, ACTOR, { name: 'Ciudad', parentId: root.id });
  const l3 = await svc.create(tenant, ACTOR, { name: 'Base', parentId: l2.id });
  const l4 = await svc.create(tenant, ACTOR, { name: 'Patio', parentId: l3.id });
  return { root, l2, l3, l4 };
}

describe('normalizers and parsers', () => {
  it('normalizes names: trimmed, single spaces, case kept, key folded', () => {
    expect(normalizeName('  Base   Norte ')).toBe('Base Norte');
    expect(nameKey('Base Norte')).toBe('base norte');
    for (const bad of ['', '   ', 'a'.repeat(81), 'x\u0001y', 'x\u0000', 7, null, undefined, {}])
      expect(code(() => normalizeName(bad))).toBe('invalid_input');
    expect(normalizeName('a'.repeat(80))).toHaveLength(80);
  });
  it('normalizes codes: upper case, null clears, strict alphabet', () => {
    expect(normalizeCode(' mx-norte.1 ')).toBe('MX-NORTE.1');
    expect(normalizeCode(null)).toBeNull();
    for (const bad of ['', '-A', 'a b', 'A'.repeat(33), 'ñ', 7, undefined])
      expect(code(() => normalizeCode(bad))).toBe('invalid_input');
  });
  it('normalizes responsibles: sorted, deduplicated, bounded', () => {
    expect(normalizeResponsibles(['u2', 'u1', 'u2'])).toEqual(['u1', 'u2']);
    expect(normalizeResponsibles([])).toEqual([]);
    const many = Array.from({ length: MAX_RESPONSIBLES + 1 }, (_, i) => `u${i}`);
    expect(code(() => normalizeResponsibles(many))).toBe('invalid_input');
    expect(normalizeResponsibles(many.slice(1))).toHaveLength(MAX_RESPONSIBLES);
    for (const bad of ['u1', null, [1], ['bad id'], [''], {}])
      expect(code(() => normalizeResponsibles(bad))).toBe('invalid_input');
  });
  it('validates opaque ids and versions', () => {
    expect(requireOpaqueId('a-1_B')).toBe('a-1_B');
    for (const bad of ['', '-a', 'a b', 'x'.repeat(65), 5, null])
      expect(code(() => requireOpaqueId(bad))).toBe('invalid_input');
    expect(requireVersion(1)).toBe(1);
    for (const bad of [0, -1, 1.5, '1', null, 2_147_483_647])
      expect(code(() => requireVersion(bad))).toBe('invalid_input');
  });
  it('parses a new area with defaults and rejects unknown or missing properties', () => {
    expect(parseNewArea({ name: ' Norte ' })).toEqual({
      name: 'Norte',
      code: null,
      parentId: null,
      responsibleIds: [],
    });
    expect(parseNewArea({ name: 'N', code: 'n1', parentId: 'p1', responsibleIds: ['u1'] })).toEqual(
      { name: 'N', code: 'N1', parentId: 'p1', responsibleIds: ['u1'] },
    );
    expect(parseNewArea({ name: 'N', parentId: null }).parentId).toBeNull();
    for (const bad of [
      {},
      { code: 'X' },
      { name: 'N', tenantId: 'other' },
      { name: 'N', parentId: 5 },
      { name: 'N', code: 5 },
      [],
      null,
      'x',
    ])
      expect(
        code(() => parseNewArea(bad)),
        JSON.stringify(bad),
      ).toBe('invalid_input');
    expect(AREA_INPUT_FIELDS).toEqual(['name', 'code', 'parentId', 'responsibleIds']);
  });
  it('parses a patch: only present fields, at least one, null parent allowed', () => {
    expect(parseAreaPatch({ name: 'X' })).toEqual({ name: 'X' });
    expect(parseAreaPatch({ parentId: null, code: null, responsibleIds: ['b', 'a'] })).toEqual({
      parentId: null,
      code: null,
      responsibleIds: ['a', 'b'],
    });
    for (const bad of [{}, { version: 1 }, { name: '' }, { parentId: 7 }, [], null])
      expect(code(() => parseAreaPatch(bad))).toBe('invalid_input');
  });
  it('knows its vocabularies', () => {
    expect(AREA_ACTIONS.every(isAreaAction)).toBe(true);
    expect(AREA_FIELDS.every(isAreaField)).toBe(true);
    expect(isAreaAction('moved')).toBe(false);
    expect(isAreaField(null)).toBe(false);
    expect(MAX_AREA_DEPTH).toBe(4);
  });
});

describe('pure rules', () => {
  const root = { id: 'r', depth: 1, active: true };
  it('computes the depth of a placement and enforces four levels, subtree included', () => {
    expect(placementDepth(null, 0)).toBe(1);
    expect(placementDepth(root, 0)).toBe(2);
    expect(placementDepth({ id: 'x', depth: 3, active: true }, 0)).toBe(4);
    expect(code(() => placementDepth({ id: 'x', depth: 4, active: true }, 0))).toBe(
      'invalid_hierarchy',
    );
    // A root with a subtree of 3 further levels fits only at the top.
    expect(placementDepth(null, 3)).toBe(1);
    expect(code(() => placementDepth(root, 3))).toBe('invalid_hierarchy');
    expect(code(() => placementDepth({ ...root, active: false }, 0))).toBe('invalid_hierarchy');
  });
  const area = (over: Partial<Area> = {}): Area => ({
    ...newArea(A, 'a1', parseNewArea({ name: 'Norte', code: 'n', responsibleIds: ['u1'] }), 1, NOW),
    ...over,
  });
  it('creates version 1, active, not deactivated', () => {
    expect(area()).toMatchObject({
      version: 1,
      active: true,
      deactivatedAt: null,
      depth: 1,
      createdAt: NOW.toISOString(),
    });
  });
  it('lists exactly the fields that change', () => {
    const a = area();
    expect(
      changedFields(a, { name: 'Norte', code: 'N', parentId: null, responsibleIds: ['u1'] }),
    ).toEqual([]);
    expect(
      changedFields(a, { name: 'Sur', code: null, parentId: 'p', responsibleIds: ['u2'] }),
    ).toEqual(['name', 'code', 'parent', 'responsibles']);
    expect(changedFields(a, { responsibleIds: ['u1', 'u2'] })).toEqual(['responsibles']);
    expect(changedFields(a, {})).toEqual([]);
  });
  it('applies a patch under the right version only, never on an inactive area', () => {
    const a = area();
    const next = applyPatch(a, { name: 'Sur', code: null }, 1, 1, LATER);
    expect(next).toMatchObject({ name: 'Sur', code: null, version: 2, depth: 1 });
    expect(next.updatedAt).toBe(LATER.toISOString());
    expect(applyPatch(a, { parentId: 'p', responsibleIds: [] }, 3, 1, LATER)).toMatchObject({
      parentId: 'p',
      depth: 3,
      responsibleIds: [],
    });
    expect(code(() => applyPatch(a, { name: 'x' }, 1, 2, LATER))).toBe('stale_version');
    expect(code(() => applyPatch({ ...a, active: false }, { name: 'x' }, 1, 1, LATER))).toBe(
      'immutable',
    );
  });
  it('toggles activity with its own transition errors and stamps the deactivation', () => {
    const a = area();
    const off = applyActive(a, false, 1, LATER);
    expect(off).toMatchObject({ active: false, deactivatedAt: LATER.toISOString(), version: 2 });
    expect(applyActive(off, true, 2, LATER)).toMatchObject({
      active: true,
      deactivatedAt: null,
      version: 3,
    });
    expect(code(() => applyActive(a, true, 1, LATER))).toBe('invalid_transition');
    expect(code(() => applyActive(off, false, 2, LATER))).toBe('invalid_transition');
    expect(code(() => applyActive(a, false, 9, LATER))).toBe('stale_version');
  });
  it('builds a history entry without names, codes or user ids', () => {
    const entry = historyEntry(area(), 'created', [], { from: null, to: null }, 'h1', ACTOR, NOW);
    expect(Object.keys(entry).sort()).toEqual([
      'action',
      'actorId',
      'areaId',
      'at',
      'fields',
      'fromParentId',
      'id',
      'tenantId',
      'toParentId',
      'version',
    ]);
    expect(JSON.stringify(entry)).not.toContain('Norte');
  });
});

describe('creating areas', () => {
  it('creates roots and children with depth, history and defaults', async () => {
    const { svc } = setup();
    const root = await svc.create(A, ACTOR, { name: 'Pais', code: 'mx', responsibleIds: ['u1'] });
    expect(root).toMatchObject({
      id: 'id-1',
      tenantId: A,
      name: 'Pais',
      code: 'MX',
      parentId: null,
      depth: 1,
      active: true,
      version: 1,
      responsibleIds: ['u1'],
    });
    const child = await svc.create(A, ACTOR, { name: 'Ciudad', parentId: root.id });
    expect(child).toMatchObject({ depth: 2, parentId: root.id, code: null, responsibleIds: [] });
    expect((await svc.history(A, root.id)).items).toMatchObject([
      { action: 'created', actorId: ACTOR, version: 1, fields: [], toParentId: null },
    ]);
    expect((await svc.history(A, child.id)).items[0]).toMatchObject({ toParentId: root.id });
  });
  it('allows four levels and refuses a fifth', async () => {
    const { svc } = setup();
    const { l3, l4 } = await chain(svc);
    expect(l4.depth).toBe(4);
    expect(await rejection(svc.create(A, ACTOR, { name: 'Cajon', parentId: l4.id }))).toMatchObject(
      { code: 'invalid_hierarchy' },
    );
    // Siblings at the deepest level are fine.
    expect((await svc.create(A, ACTOR, { name: 'Patio 2', parentId: l3.id })).depth).toBe(4);
  });
  it('refuses unknown, foreign and inactive parents with the same error', async () => {
    const { svc } = setup();
    const foreign = await svc.create(B, ACTOR, { name: 'Ajena' });
    const mine = await svc.create(A, ACTOR, { name: 'Mia' });
    await svc.deactivate(A, ACTOR, mine.id, 1);
    for (const parentId of ['ghost', foreign.id, mine.id])
      expect(await rejection(svc.create(A, ACTOR, { name: 'Hija', parentId }))).toMatchObject({
        code: 'invalid_hierarchy',
      });
    expect((await svc.list(A, { includeInactive: true })).total).toBe(1);
  });
  it('rejects duplicate sibling names and duplicate codes, naming only the key', async () => {
    const { svc } = setup();
    const root = await svc.create(A, ACTOR, { name: 'Norte', code: 'N1' });
    expect(await rejection(svc.create(A, ACTOR, { name: 'NORTE' }))).toEqual(
      new AreaError('duplicate', 'name'),
    );
    expect(await rejection(svc.create(A, ACTOR, { name: 'Sur', code: 'n1' }))).toEqual(
      new AreaError('duplicate', 'code'),
    );
    // The same name under another parent, and in another tenant, is fine; the code is per company.
    expect((await svc.create(A, ACTOR, { name: 'Norte', parentId: root.id })).depth).toBe(2);
    expect((await svc.create(B, ACTOR, { name: 'Norte', code: 'N1' })).tenantId).toBe(B);
    expect((await svc.create(A, ACTOR, { name: 'Otra', code: null })).code).toBeNull();
    expect((await svc.create(A, ACTOR, { name: 'Otra2' })).code).toBeNull();
  });
  it('validates inputs, tenant and actor before touching the store', async () => {
    const { svc, store } = setup();
    for (const [tenant, actor, body] of [
      ['', ACTOR, { name: 'X' }],
      [A, 'bad actor', { name: 'X' }],
      [A, ACTOR, {}],
      [A, ACTOR, { name: 'X', tenantId: B }],
    ] as const)
      expect(await rejection(svc.create(tenant, actor, body))).toMatchObject({
        code: 'invalid_input',
      });
    expect((await store.list(A, { includeInactive: true }, { limit: 5, offset: 0 })).total).toBe(0);
  });
});

describe('responsible users (FR-041)', () => {
  const members = (...ids: string[]): AreaMemberDirectory => ({
    isActiveMember: async (tenantId, userId) => tenantId === A && ids.includes(userId),
  });
  it('accepts opaque ids when no directory is wired and members when one is', async () => {
    const open = setup();
    expect(
      (await open.svc.create(A, ACTOR, { name: 'X', responsibleIds: ['anyone'] })).responsibleIds,
    ).toEqual(['anyone']);
    const { svc } = setup({ members: members('u1', 'u2') });
    expect(
      (await svc.create(A, ACTOR, { name: 'Norte', responsibleIds: ['u2', 'u1'] })).responsibleIds,
    ).toEqual(['u1', 'u2']);
    expect(
      await rejection(svc.create(A, ACTOR, { name: 'Sur', responsibleIds: ['u1', 'stranger'] })),
    ).toMatchObject({ code: 'invalid_responsible' });
    // Nothing was written by the rejected creation.
    expect((await svc.list(A)).total).toBe(1);
  });
  it('validates only the users that are added, so a departed member can always be removed', async () => {
    let active = ['u1', 'u2'];
    const { svc } = setup({
      members: { isActiveMember: async (_t, userId) => active.includes(userId) },
    });
    const area = await svc.create(A, ACTOR, { name: 'Norte', responsibleIds: ['u1', 'u2'] });
    active = ['u2'];
    // Renaming keeps the departed responsible untouched.
    const renamed = await svc.update(A, ACTOR, area.id, 1, { name: 'Norte 2' });
    expect(renamed.area.responsibleIds).toEqual(['u1', 'u2']);
    // Adding a stranger is refused; removing the departed one is allowed.
    expect(
      await rejection(svc.update(A, ACTOR, area.id, 2, { responsibleIds: ['u1', 'u2', 'u9'] })),
    ).toMatchObject({ code: 'invalid_responsible' });
    const removed = await svc.update(A, ACTOR, area.id, 2, { responsibleIds: ['u2'] });
    expect(removed).toMatchObject({
      area: { responsibleIds: ['u2'], version: 3 },
      fields: ['responsibles'],
    });
  });
});

describe('editing and moving areas', () => {
  it('renames, recodes and clears the code with history by field name', async () => {
    const { svc } = setup();
    const area = await svc.create(A, ACTOR, { name: 'Norte', code: 'n' });
    const edited = await svc.update(A, ACTOR, area.id, 1, { name: 'Norte 2', code: null });
    expect(edited.fields).toEqual(['name', 'code']);
    expect(edited.area).toMatchObject({ name: 'Norte 2', code: null, version: 2 });
    const history = (await svc.history(A, area.id)).items;
    expect(history.map((entry) => [entry.version, entry.action, entry.fields])).toEqual([
      [2, 'updated', ['name', 'code']],
      [1, 'created', []],
    ]);
    expect(JSON.stringify(history)).not.toContain('Norte');
  });
  it('treats an edit that changes nothing as a no-op without a new version', async () => {
    const { svc } = setup();
    const area = await svc.create(A, ACTOR, { name: 'Norte', code: 'n', responsibleIds: ['u1'] });
    const same = await svc.update(A, ACTOR, area.id, 1, {
      name: ' norte'.replace('n', 'N'),
      code: 'N',
      responsibleIds: ['u1'],
    });
    expect(same).toEqual({ area, fields: [] });
    expect((await svc.history(A, area.id)).total).toBe(1);
    // The version is still checked on a no-op.
    expect(await rejection(svc.update(A, ACTOR, area.id, 7, { name: 'Norte' }))).toMatchObject({
      code: 'stale_version',
    });
  });
  it('detects stale versions, inactive areas and unknown ids', async () => {
    const { svc } = setup();
    const area = await svc.create(A, ACTOR, { name: 'Norte' });
    await svc.update(A, ACTOR, area.id, 1, { name: 'N2' });
    expect(await rejection(svc.update(A, ACTOR, area.id, 1, { name: 'N3' }))).toMatchObject({
      code: 'stale_version',
    });
    await svc.deactivate(A, ACTOR, area.id, 2);
    expect(await rejection(svc.update(A, ACTOR, area.id, 3, { name: 'N3' }))).toMatchObject({
      code: 'immutable',
    });
    expect(await rejection(svc.update(A, ACTOR, 'ghost', 1, { name: 'x' }))).toMatchObject({
      code: 'not_found',
    });
    expect(await rejection(svc.update(A, ACTOR, area.id, 'x', { name: 'x' }))).toMatchObject({
      code: 'invalid_input',
    });
    expect(await rejection(svc.update(A, ACTOR, area.id, 3, {}))).toMatchObject({
      code: 'invalid_input',
    });
  });
  it('refuses a rename that collides with a sibling or a code that is taken', async () => {
    const { svc } = setup();
    await svc.create(A, ACTOR, { name: 'Norte', code: 'N' });
    const sur = await svc.create(A, ACTOR, { name: 'Sur', code: 'S' });
    expect(await rejection(svc.update(A, ACTOR, sur.id, 1, { name: 'norte' }))).toEqual(
      new AreaError('duplicate', 'name'),
    );
    expect(await rejection(svc.update(A, ACTOR, sur.id, 1, { code: 'n' }))).toEqual(
      new AreaError('duplicate', 'code'),
    );
    expect((await svc.get(A, sur.id)).version).toBe(1);
  });

  it('moves a leaf under another parent and to the root, recording both parents', async () => {
    const { svc } = setup();
    const { root, l2, l3 } = await chain(svc);
    const moved = await svc.update(A, ACTOR, l3.id, 1, { parentId: root.id });
    expect(moved).toMatchObject({ fields: ['parent'], area: { parentId: root.id, depth: 2 } });
    const toRoot = await svc.update(A, ACTOR, l3.id, 2, { parentId: null });
    expect(toRoot.area).toMatchObject({ parentId: null, depth: 1 });
    const history = (await svc.history(A, l3.id)).items;
    expect(history[0]).toMatchObject({ fromParentId: root.id, toParentId: null });
    expect(history[1]).toMatchObject({ fromParentId: l2.id, toParentId: root.id });
  });
  it('moves a whole subtree and re-computes the depth of every descendant', async () => {
    const { svc } = setup();
    const { root, l2, l3, l4 } = await chain(svc);
    const other = await svc.create(A, ACTOR, { name: 'Otra raiz' });
    // l3 (with l4) from level 3 to level 2 under `other`: l4 goes from 4 to 3.
    await svc.update(A, ACTOR, l3.id, 1, { parentId: other.id });
    expect((await svc.get(A, l3.id)).depth).toBe(2);
    expect((await svc.get(A, l4.id)).depth).toBe(3);
    // Up to a root: l4 is now level 2; descendants keep their own parent.
    await svc.update(A, ACTOR, l3.id, 2, { parentId: null });
    expect(await Promise.all([l3.id, l4.id].map((id) => svc.get(A, id)))).toMatchObject([
      { depth: 1, parentId: null },
      { depth: 2, parentId: l3.id },
    ]);
    // Descendants are not changed as rows: no new version, no history.
    expect(await svc.get(A, l4.id)).toMatchObject({ version: 1 });
    expect((await svc.history(A, l4.id)).total).toBe(1);
    expect([root.id, l2.id].length).toBe(2);
  });
  it('refuses a move that would make a fifth level once the subtree is counted', async () => {
    const { svc } = setup();
    const { l2, l3 } = await chain(svc);
    const a = await svc.create(A, ACTOR, { name: 'A' });
    const b = await svc.create(A, ACTOR, { name: 'B', parentId: a.id });
    const c = await svc.create(A, ACTOR, { name: 'C', parentId: b.id });
    // `a` (height 2) under l3 (level 3) would reach level 5.
    expect(await rejection(svc.update(A, ACTOR, a.id, 1, { parentId: l3.id }))).toMatchObject({
      code: 'invalid_hierarchy',
    });
    // Under l2 (level 2) the subtree reaches level 5 too (2+1+2 = 5): refused.
    expect(await rejection(svc.update(A, ACTOR, a.id, 1, { parentId: l2.id }))).toMatchObject({
      code: 'invalid_hierarchy',
    });
    // Under a root it reaches 3 + ... fine: `a` under the chain root gives levels 2..4.
    const root = await svc.get(A, l2.parentId as string);
    const ok = await svc.update(A, ACTOR, a.id, 1, { parentId: root.id });
    expect(ok.area.depth).toBe(2);
    expect((await svc.get(A, c.id)).depth).toBe(4);
    // The rejected moves changed nothing.
    expect((await svc.get(A, b.id)).depth).toBe(3);
  });
  it('refuses cycles: itself, a child and any descendant', async () => {
    const { svc } = setup();
    const { root, l2, l4 } = await chain(svc);
    for (const parentId of [root.id, l2.id, l4.id])
      expect(await rejection(svc.update(A, ACTOR, root.id, 1, { parentId }))).toMatchObject({
        code: 'invalid_hierarchy',
      });
    expect(await rejection(svc.update(A, ACTOR, l2.id, 1, { parentId: l4.id }))).toMatchObject({
      code: 'invalid_hierarchy',
    });
    expect((await svc.get(A, root.id)).version).toBe(1);
  });
  it('refuses to move under an unknown, foreign or inactive parent', async () => {
    const { svc } = setup();
    const foreign = await svc.create(B, ACTOR, { name: 'Ajena' });
    const idle = await svc.create(A, ACTOR, { name: 'Inactiva' });
    await svc.deactivate(A, ACTOR, idle.id, 1);
    const leaf = await svc.create(A, ACTOR, { name: 'Hoja' });
    for (const parentId of ['ghost', foreign.id, idle.id])
      expect(await rejection(svc.update(A, ACTOR, leaf.id, 1, { parentId }))).toMatchObject({
        code: 'invalid_hierarchy',
      });
  });
  it('refuses a move that collides with a sibling name at the destination', async () => {
    const { svc } = setup();
    const root = await svc.create(A, ACTOR, { name: 'Raiz' });
    await svc.create(A, ACTOR, { name: 'Base', parentId: root.id });
    const loose = await svc.create(A, ACTOR, { name: 'base' });
    expect(await rejection(svc.update(A, ACTOR, loose.id, 1, { parentId: root.id }))).toEqual(
      new AreaError('duplicate', 'name'),
    );
    expect(await svc.get(A, loose.id)).toMatchObject({ parentId: null, depth: 1, version: 1 });
  });
  it('rolls back a failed edit completely (store transaction)', async () => {
    const { svc } = setup();
    const { l3 } = await chain(svc);
    const a = await svc.create(A, ACTOR, { name: 'A' });
    await svc.create(A, ACTOR, { name: 'Base', parentId: a.id });
    // Same name as the sibling at the destination: nothing of the move may stay.
    await rejection(svc.update(A, ACTOR, l3.id, 1, { parentId: a.id }));
    expect(await svc.get(A, l3.id)).toMatchObject({ depth: 3, version: 1 });
  });
});

describe('deactivation and reactivation (FR-042, BR-021, BR-009)', () => {
  const counter = (count: number): AreaResourceCounter & { calls: string[] } => ({
    calls: [],
    countActive(tenantId, areaId) {
      this.calls.push(`${tenantId}/${areaId}`);
      return Promise.resolve(count);
    },
  });
  it('deactivates an empty area softly: the row stays, history and timestamps are written', async () => {
    const { svc } = setup();
    const area = await svc.create(A, ACTOR, { name: 'Norte' });
    const off = await svc.deactivate(A, ACTOR, area.id, 1);
    expect(off).toMatchObject({ active: false, version: 2, deactivatedAt: NOW.toISOString() });
    expect((await svc.get(A, area.id)).active).toBe(false);
    expect((await svc.list(A)).total).toBe(0);
    expect((await svc.list(A, { includeInactive: true })).total).toBe(1);
    expect((await svc.history(A, area.id)).items[0]).toMatchObject({
      action: 'deactivated',
      actorId: ACTOR,
      fields: [],
    });
  });
  it('refuses while active vehicles or people remain, naming the kind and nothing else', async () => {
    const vehicles = counter(2);
    const people = counter(0);
    const { svc } = setup({ vehicles, people });
    const area = await svc.create(A, ACTOR, { name: 'Norte' });
    expect(await rejection(svc.deactivate(A, ACTOR, area.id, 1))).toEqual(
      new AreaError('area_in_use', 'vehicles'),
    );
    expect(vehicles.calls).toEqual([`${A}/${area.id}`]);
    const withPeople = setup({ vehicles: counter(0), people: counter(1) });
    const second = await withPeople.svc.create(A, ACTOR, { name: 'Norte' });
    expect(await rejection(withPeople.svc.deactivate(A, ACTOR, second.id, 1))).toEqual(
      new AreaError('area_in_use', 'people'),
    );
    expect((await svc.get(A, area.id)).active).toBe(true);
  });
  it('counts per tenant and area through the ports (no cross-tenant counting)', async () => {
    const vehicles = counter(0);
    const { svc } = setup({ vehicles });
    const a = await svc.create(A, ACTOR, { name: 'Norte' });
    const b = await svc.create(B, ACTOR, { name: 'Norte' });
    await svc.deactivate(B, ACTOR, b.id, 1);
    expect(vehicles.calls).toEqual([`${B}/${b.id}`]);
    expect(await svc.usage(A, a.id)).toEqual({ vehicles: 0, people: 0 });
    expect(vehicles.calls).toEqual([`${B}/${b.id}`, `${A}/${a.id}`]);
    expect(await rejection(svc.usage(A, b.id))).toMatchObject({ code: 'not_found' });
  });
  it('refuses while active sub-areas remain and succeeds once they are deactivated (no cascade)', async () => {
    const { svc } = setup();
    const { root, l2 } = await chain(svc);
    expect(await rejection(svc.deactivate(A, ACTOR, root.id, 1))).toEqual(
      new AreaError('area_in_use', 'sub_areas'),
    );
    expect(await rejection(svc.deactivate(A, ACTOR, l2.id, 1))).toEqual(
      new AreaError('area_in_use', 'sub_areas'),
    );
    // Deactivate from the leaves up; each parent stays active until its children are inactive.
    const l3 = (await svc.list(A, { parentId: l2.id })).items[0] as Area;
    const l4 = (await svc.list(A, { parentId: l3.id })).items[0] as Area;
    await svc.deactivate(A, ACTOR, l4.id, 1);
    await svc.deactivate(A, ACTOR, l3.id, 1);
    await svc.deactivate(A, ACTOR, l2.id, 1);
    expect((await svc.deactivate(A, ACTOR, root.id, 1)).active).toBe(false);
    // Inactive areas stay in the tree: they were never removed or cascaded.
    expect((await svc.list(A, { includeInactive: true })).total).toBe(4);
  });
  it('rejects stale versions, repeated deactivation and unknown ids', async () => {
    const { svc } = setup();
    const area = await svc.create(A, ACTOR, { name: 'Norte' });
    expect(await rejection(svc.deactivate(A, ACTOR, area.id, 5))).toMatchObject({
      code: 'stale_version',
    });
    await svc.deactivate(A, ACTOR, area.id, 1);
    expect(await rejection(svc.deactivate(A, ACTOR, area.id, 2))).toMatchObject({
      code: 'invalid_transition',
    });
    expect(await rejection(svc.deactivate(A, ACTOR, 'ghost', 1))).toMatchObject({
      code: 'not_found',
    });
    expect(await rejection(svc.deactivate(A, ACTOR, area.id, 0))).toMatchObject({
      code: 'invalid_input',
    });
  });
  it('reactivates an area, only under an active parent', async () => {
    const { svc } = setup();
    const root = await svc.create(A, ACTOR, { name: 'Raiz' });
    const child = await svc.create(A, ACTOR, { name: 'Hija', parentId: root.id });
    await svc.deactivate(A, ACTOR, child.id, 1);
    await svc.deactivate(A, ACTOR, root.id, 1);
    expect(await rejection(svc.activate(A, ACTOR, child.id, 2))).toMatchObject({
      code: 'invalid_hierarchy',
    });
    const back = await svc.activate(A, ACTOR, root.id, 2);
    expect(back).toMatchObject({ active: true, deactivatedAt: null, version: 3 });
    expect((await svc.activate(A, ACTOR, child.id, 2)).active).toBe(true);
    expect(await rejection(svc.activate(A, ACTOR, child.id, 3))).toMatchObject({
      code: 'invalid_transition',
    });
    expect(await rejection(svc.activate(A, ACTOR, child.id, 1))).toMatchObject({
      code: 'stale_version',
    });
    expect(await rejection(svc.activate(A, ACTOR, 'ghost', 1))).toMatchObject({
      code: 'not_found',
    });
    expect((await svc.history(A, child.id)).items.map((entry) => entry.action)).toEqual([
      'activated',
      'deactivated',
      'created',
    ]);
  });
  it('keeps an inactive area in the depth budget of its parent move (subtree includes inactive)', async () => {
    const { svc } = setup();
    const a = await svc.create(A, ACTOR, { name: 'A' });
    const b = await svc.create(A, ACTOR, { name: 'B', parentId: a.id });
    const c = await svc.create(A, ACTOR, { name: 'C', parentId: b.id });
    await svc.deactivate(A, ACTOR, c.id, 1);
    const l1 = await svc.create(A, ACTOR, { name: 'X' });
    const l2 = await svc.create(A, ACTOR, { name: 'Y', parentId: l1.id });
    const l3 = await svc.create(A, ACTOR, { name: 'Z', parentId: l2.id });
    // `a` has an inactive grandchild: a (1) b (2) c (3); under l3 it would reach level 6.
    expect(await rejection(svc.update(A, ACTOR, a.id, 1, { parentId: l3.id }))).toMatchObject({
      code: 'invalid_hierarchy',
    });
    // Under l1 it reaches 4: fine, and the inactive descendant moves along.
    await svc.update(A, ACTOR, a.id, 1, { parentId: l1.id });
    expect((await svc.get(A, c.id)).depth).toBe(4);
  });
});

describe('reads', () => {
  it('lists by name then id, filters by parent and activity, and windows with a total', async () => {
    const { svc } = setup();
    const b = await svc.create(A, ACTOR, { name: 'b' });
    const a = await svc.create(A, ACTOR, { name: 'A' });
    const c = await svc.create(A, ACTOR, { name: 'C', parentId: b.id });
    await svc.create(B, ACTOR, { name: 'Ajena' });
    const names = async (query = {}) => (await svc.list(A, query)).items.map((x) => x.name);
    expect(await names()).toEqual(['A', 'b', 'C']);
    expect(await names({ parentId: null })).toEqual(['A', 'b']);
    expect(await names({ parentId: b.id })).toEqual(['C']);
    await svc.deactivate(A, ACTOR, a.id, 1);
    expect(await names()).toEqual(['b', 'C']);
    expect(await names({ includeInactive: true })).toEqual(['A', 'b', 'C']);
    const page = await svc.list(A, { includeInactive: true, limit: 1, offset: 1 });
    expect(page.items.map((x) => x.id)).toEqual([b.id]);
    expect(page.total).toBe(3);
    expect([a.id, c.id].length).toBe(2);
  });
  it('orders areas with the same name by id', async () => {
    const { svc } = setup();
    const root = await svc.create(A, ACTOR, { name: 'Raiz' });
    const other = await svc.create(A, ACTOR, { name: 'Raiz 2' });
    await svc.create(A, ACTOR, { name: 'Misma', parentId: root.id });
    await svc.create(A, ACTOR, { name: 'Misma', parentId: other.id });
    const same = (await svc.list(A)).items.filter((area) => area.name === 'Misma');
    expect(same.map((area) => area.id)).toEqual([...same.map((area) => area.id)].sort());
  });
  it('rejects malformed list and history queries', async () => {
    const { svc } = setup();
    const area = await svc.create(A, ACTOR, { name: 'N' });
    for (const query of [
      { limit: 0 },
      { limit: 101 },
      { limit: '5' },
      { offset: -1 },
      { offset: 1_000_001 },
      { includeInactive: 'yes' },
      { parentId: 7 },
      { parentId: 'bad id' },
    ])
      expect(await rejection(svc.list(A, query)), JSON.stringify(query)).toMatchObject({
        code: 'invalid_input',
      });
    expect(await rejection(svc.history(A, area.id, { limit: 0 }))).toMatchObject({
      code: 'invalid_input',
    });
    expect(await rejection(svc.list(''))).toMatchObject({ code: 'invalid_input' });
  });
  it('pages the history newest first with a total', async () => {
    const { svc } = setup();
    const area = await svc.create(A, ACTOR, { name: 'N' });
    await svc.update(A, ACTOR, area.id, 1, { name: 'N2' });
    await svc.update(A, ACTOR, area.id, 2, { name: 'N3' });
    const first = await svc.history(A, area.id, { limit: 2 });
    expect(first.total).toBe(3);
    expect(first.items.map((e) => e.version)).toEqual([3, 2]);
    expect(
      (await svc.history(A, area.id, { limit: 2, offset: 2 })).items.map((e) => e.version),
    ).toEqual([1]);
  });
});

describe('tenant isolation', () => {
  it('answers not_found to another tenant for every id-based use case, as for an unknown id', async () => {
    const { svc } = setup();
    const mine = await svc.create(A, ACTOR, { name: 'Mia' });
    const calls = (id: string) => [
      () => svc.get(B, id),
      () => svc.usage(B, id),
      () => svc.history(B, id),
      () => svc.update(B, ACTOR, id, 1, { name: 'Robada' }),
      () => svc.deactivate(B, ACTOR, id, 1),
      () => svc.activate(B, ACTOR, id, 1),
    ];
    for (const [index, call] of calls(mine.id).entries()) {
      const foreign = await rejection(call());
      const unknown = await rejection((calls('ghost')[index] as () => Promise<unknown>)());
      expect([foreign.code, foreign.field]).toEqual(['not_found', undefined]);
      expect(foreign).toEqual(unknown);
    }
    expect(await svc.get(A, mine.id)).toMatchObject({ name: 'Mia', version: 1 });
  });
  it('refuses a store that returns a row of another tenant', async () => {
    const inner = new InMemoryAreaStore();
    const leaky: AreaStore = {
      transaction: (t, w) => inner.transaction(t, w),
      find: async (_tenant, id) => inner.find(A, id),
      list: (t, f, w) => inner.list(t, f, w),
      history: (t, a, w) => inner.history(t, a, w),
    };
    const { svc } = setup({ store: leaky });
    await svc.create(A, ACTOR, { name: 'Mia' });
    expect(await rejection(svc.get(B, 'id-1'))).toMatchObject({ code: 'not_found' });
  });
  it('serializes concurrent hierarchy changes of one tenant: two crossing moves cannot make a cycle', async () => {
    const { svc } = setup();
    const a = await svc.create(A, ACTOR, { name: 'A' });
    const b = await svc.create(A, ACTOR, { name: 'B' });
    const results = await Promise.allSettled([
      svc.update(A, ACTOR, a.id, 1, { parentId: b.id }),
      svc.update(A, ACTOR, b.id, 1, { parentId: a.id }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(
      ((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason as AreaError)
        .code,
    ).toBe('invalid_hierarchy');
  });
  it('never lets two concurrent writes with the same version both win', async () => {
    const { svc } = setup();
    const a = await svc.create(A, ACTOR, { name: 'A' });
    const results = await Promise.allSettled([
      svc.update(A, ACTOR, a.id, 1, { name: 'Uno' }),
      svc.update(A, ACTOR, a.id, 1, { name: 'Dos' }),
      svc.deactivate(A, ACTOR, a.id, 1),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
});

describe('in-memory store contract', () => {
  it('does not insert the same id twice and keeps a failed transaction out of the state', async () => {
    const store = new InMemoryAreaStore();
    const area = newArea(A, 'a1', parseNewArea({ name: 'N' }), 1, NOW);
    const entry = historyEntry(area, 'created', [], { from: null, to: null }, 'h1', ACTOR, NOW);
    await store.transaction(A, (tx) => tx.insert(area, entry));
    expect(
      await rejection(store.transaction(A, (tx) => tx.insert({ ...area, name: 'Otra' }, entry))),
    ).toEqual(new AreaError('duplicate'));
    expect(
      await rejection(
        store.transaction(A, (tx) => tx.insert({ ...area, tenantId: B, id: 'a2' }, entry)),
      ),
    ).toEqual(new AreaError('duplicate'));
    await expect(
      store.transaction(A, async (tx) => {
        await tx.insert({ ...area, id: 'a3', name: 'Tres' }, { ...entry, id: 'h3', areaId: 'a3' });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await store.find(A, 'a3')).toBeNull();
    expect((await store.history(A, 'a3', { limit: 5, offset: 0 })).total).toBe(0);
  });
  it('replaces only under the stored version and never in another tenant; setDepth ignores unknown ids', async () => {
    const store = new InMemoryAreaStore();
    const area = newArea(A, 'a1', parseNewArea({ name: 'N' }), 1, NOW);
    const entry = historyEntry(area, 'created', [], { from: null, to: null }, 'h1', ACTOR, NOW);
    await store.transaction(A, (tx) => tx.insert(area, entry));
    const next = { ...area, version: 2, name: 'M' };
    const result = await store.transaction(A, async (tx) => ({
      stale: await tx.replace(next, 9, { ...entry, id: 'h2', version: 2 }),
      foreign: await tx.replace({ ...next, tenantId: B }, 1, { ...entry, id: 'h3', version: 2 }),
      ok: await tx.replace(next, 1, { ...entry, id: 'h2', version: 2 }),
      children: await tx.children(null),
    }));
    expect(result).toMatchObject({ stale: false, foreign: false, ok: true });
    expect(result.children).toEqual([{ id: 'a1', depth: 1, active: true }]);
    await store.transaction(A, (tx) => tx.setDepth('ghost', 3));
    expect((await store.find(A, 'a1'))?.name).toBe('M');
  });
  it('uses the real clock and random ids by default', async () => {
    const svc = new AreaService(new InMemoryAreaStore(), {
      resources: { vehicles: NO_RESOURCES, people: NO_RESOURCES },
    });
    const created = await svc.create(A, ACTOR, { name: 'N' });
    expect(created.id).toMatch(/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/);
    expect(await NO_RESOURCES.countActive(A, created.id)).toBe(0);
  });
});
