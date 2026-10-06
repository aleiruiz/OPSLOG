import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_TYPES,
  DocumentError,
  DocumentService,
  EXPIRING_WINDOW_DAYS,
  InMemoryDocumentStore,
  addDays,
  applyArchive,
  applyPatch,
  applyRenewal,
  expiryFilterOf,
  expiryKeyOf,
  expiryOf,
  isDocumentStatus,
  isDocumentType,
  isOwnerType,
  matchesExpiry,
  newDocument,
  normalizeDocumentNumber,
  parseDocumentPatch,
  parseNewDocument,
  parseRenewal,
  requireOpaqueId,
  requireVersion,
  revisionOf,
  revisionStatus,
  type Document,
  type DocumentOwnerGate,
  type DocumentStore,
} from './index.js';

const NOW = new Date('2026-10-06T12:00:00.000Z');
const A = 'tenant-a';
const B = 'tenant-b';
const ACTOR = 'user-11111111-1111-4111-8111-111111111111';

const card = (over: Record<string, unknown> = {}) => ({
  ownerType: 'vehicle',
  ownerId: 'veh-1',
  typeCode: 'registration_card',
  title: 'Tarjeta de circulación',
  expiresOn: '2027-03-31',
  ...over,
});

const rejects = async (work: () => unknown, code: string, field?: string) => {
  const error: unknown = await Promise.resolve()
    .then(work)
    .then(
      () => null,
      (e: unknown) => e,
    );
  expect(error).toBeInstanceOf(DocumentError);
  expect(error).toMatchObject({ code, ...(field ? { field } : {}) });
};
const throwsInvalid = (work: () => unknown) => {
  expect(work).toThrow(DocumentError);
  try {
    work();
  } catch (error) {
    expect((error as DocumentError).code).toBe('invalid_input');
  }
};

function service(over: { owners?: DocumentOwnerGate; store?: DocumentStore; now?: Date } = {}) {
  let ids = 0;
  let clock = over.now ?? NOW;
  const store = over.store ?? new InMemoryDocumentStore();
  const svc = new DocumentService(store, {
    ...(over.owners ? { owners: over.owners } : {}),
    now: () => clock,
    newId: () => `doc-${(ids += 1)}`,
  });
  return {
    svc,
    store,
    setNow: (value: Date) => {
      clock = value;
    },
  };
}

describe('catalog and guards', () => {
  it('lists types per owner and flags the ones that need an expiry', () => {
    expect(DOCUMENT_TYPES.vehicle['registration_card']).toBe('required');
    expect(DOCUMENT_TYPES.vehicle['ownership_title']).toBe('optional');
    expect(DOCUMENT_TYPES.employee['medical_exam']).toBe('required');
    expect(isOwnerType('vehicle')).toBe(true);
    expect(isOwnerType('policy')).toBe(false);
    expect(isOwnerType(3)).toBe(false);
    expect(isDocumentType('vehicle', 'registration_card')).toBe(true);
    expect(isDocumentType('employee', 'registration_card')).toBe(false);
    expect(isDocumentType('vehicle', 'toString')).toBe(false);
    expect(isDocumentType('vehicle', 7)).toBe(false);
    expect(isDocumentStatus('expiring')).toBe(true);
    expect(isDocumentStatus('replaced')).toBe(false);
  });

  it('validates ids, versions and document numbers', () => {
    expect(requireOpaqueId('abc_1-2')).toBe('abc_1-2');
    for (const bad of ['', '-x', 'a'.repeat(65), 'a b', 5, null])
      throwsInvalid(() => requireOpaqueId(bad));
    expect(requireVersion(3)).toBe(3);
    for (const bad of [0, 1.5, '1', 2_147_483_647, null]) throwsInvalid(() => requireVersion(bad));
    expect(normalizeDocumentNumber('  tc 123/ab ')).toBe('TC 123/AB');
    for (const bad of ['', '   ', '-1', 'a'.repeat(41), 'ñ12', 4])
      throwsInvalid(() => normalizeDocumentNumber(bad));
  });
});

describe('expiry derivation', () => {
  it('treats the last valid day as inclusive and flags the window', () => {
    expect(expiryOf(null, '2026-10-06')).toEqual({ status: 'valid', daysToExpiry: null });
    expect(expiryOf('2026-10-05', '2026-10-06')).toEqual({ status: 'expired', daysToExpiry: -1 });
    expect(expiryOf('2026-10-06', '2026-10-06')).toEqual({ status: 'expiring', daysToExpiry: 0 });
    expect(expiryOf('2026-11-05', '2026-10-06')).toEqual({ status: 'expiring', daysToExpiry: 30 });
    expect(expiryOf('2026-11-06', '2026-10-06')).toEqual({ status: 'valid', daysToExpiry: 31 });
    expect(EXPIRING_WINDOW_DAYS).toBe(30);
  });

  it('adds days across month and year boundaries', () => {
    expect(addDays('2026-12-15', 30)).toBe('2027-01-14');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });

  it('keeps the filter and the key in agreement', () => {
    const today = '2026-10-06';
    const filter = (status: 'valid' | 'expiring' | 'expired') => expiryFilterOf(status, today);
    expect(expiryKeyOf(null)).toBe('9999-12-31');
    expect(expiryKeyOf('2026-01-01')).toBe('2026-01-01');
    for (const key of ['2026-10-05', '2026-10-06', '2026-11-05', '2026-11-06', '9999-12-31']) {
      const status = expiryOf(key === '9999-12-31' ? null : key, today).status;
      for (const candidate of ['valid', 'expiring', 'expired'] as const)
        expect(matchesExpiry(key, filter(candidate))).toBe(candidate === status);
    }
  });

  it('marks older revisions as replaced and derives the current one', () => {
    expect(revisionStatus({ revision: 1, expiresOn: '2020-01-01' }, 2, '2026-10-06')).toBe(
      'replaced',
    );
    expect(revisionStatus({ revision: 2, expiresOn: '2020-01-01' }, 2, '2026-10-06')).toBe(
      'expired',
    );
    expect(revisionStatus({ revision: 2, expiresOn: null }, 2, '2026-10-06')).toBe('valid');
  });
});

describe('parseNewDocument', () => {
  it('normalizes a complete input', () => {
    expect(
      parseNewDocument(
        card({
          title: '  Tarjeta   de  circulación ',
          notes: ' original en archivo ',
          issuedOn: '2025-03-31',
          documentNumber: ' tc-001 ',
        }),
        NOW,
      ),
    ).toEqual({
      ownerType: 'vehicle',
      ownerId: 'veh-1',
      typeCode: 'registration_card',
      title: 'Tarjeta de circulación',
      notes: 'original en archivo',
      revision: { issuedOn: '2025-03-31', expiresOn: '2027-03-31', documentNumber: 'TC-001' },
    });
  });

  it('accepts optional-expiry types without dates and treats null like absent', () => {
    const parsed = parseNewDocument(
      card({ typeCode: 'ownership_title', expiresOn: null, notes: null, issuedOn: null }),
      NOW,
    );
    expect(parsed.revision).toEqual({ issuedOn: null, expiresOn: null, documentNumber: null });
    expect(parsed.notes).toBeNull();
    const bare = card({ typeCode: 'other' });
    delete (bare as Record<string, unknown>)['expiresOn'];
    expect(parseNewDocument(bare, NOW).revision.expiresOn).toBeNull();
  });

  it('rejects what the rules forbid', () => {
    const cases: unknown[] = [
      null,
      [],
      'x',
      card({ extra: 1 }),
      card({ tenantId: 'other' }),
      card({ ownerType: 'policy' }),
      card({ ownerType: 'employee' }),
      card({ typeCode: 'nope' }),
      card({ typeCode: 'toString' }),
      card({ ownerId: 'a b' }),
      card({ title: '' }),
      card({ title: 'x'.repeat(81) }),
      card({ title: 'a\u0007b' }),
      card({ notes: 'a\tb' }),
      card({ notes: 'x'.repeat(501) }),
      card({ expiresOn: null }),
      card({ expiresOn: '2027-02-30' }),
      card({ expiresOn: '2027-3-1' }),
      card({ expiresOn: '2101-01-01' }),
      card({ expiresOn: '1949-12-31' }),
      card({ issuedOn: '2026-10-07' }),
      card({ issuedOn: '2027-04-01' }),
      card({ documentNumber: '??' }),
    ];
    for (const input of cases) throwsInvalid(() => parseNewDocument(input, NOW));
    for (const key of ['ownerType', 'ownerId', 'typeCode', 'title']) {
      const partial: Record<string, unknown> = card();
      delete partial[key];
      throwsInvalid(() => parseNewDocument(partial, NOW));
    }
  });

  it('allows an expiry equal to the issue date and an issue date of today', () => {
    expect(
      parseNewDocument(card({ issuedOn: '2026-10-06', expiresOn: '2026-10-06' }), NOW).revision,
    ).toMatchObject({ issuedOn: '2026-10-06', expiresOn: '2026-10-06' });
  });
});

describe('parseRenewal and parseDocumentPatch', () => {
  it('applies the type rule to a renewal', () => {
    expect(parseRenewal({ expiresOn: '2028-01-01' }, NOW, 'vehicle', 'registration_card')).toEqual({
      issuedOn: null,
      expiresOn: '2028-01-01',
      documentNumber: null,
    });
    throwsInvalid(() => parseRenewal({}, NOW, 'vehicle', 'registration_card'));
    throwsInvalid(() =>
      parseRenewal({ expiresOn: '2028-01-01', title: 'x' }, NOW, 'vehicle', 'registration_card'),
    );
    expect(parseRenewal({}, NOW, 'employee', 'other').expiresOn).toBeNull();
  });

  it('accepts only title and notes in a patch, at least one', () => {
    expect(parseDocumentPatch({ title: ' Nuevo ' })).toEqual({ title: 'Nuevo' });
    expect(parseDocumentPatch({ notes: null })).toEqual({ notes: null });
    expect(parseDocumentPatch({ notes: 'nota', title: 'T' })).toEqual({
      notes: 'nota',
      title: 'T',
    });
    for (const bad of [{}, { expiresOn: '2027-01-01' }, { ownerId: 'x' }, { title: '' }, [], null])
      throwsInvalid(() => parseDocumentPatch(bad));
  });
});

describe('pure state changes', () => {
  const base = (): Document => newDocument(A, 'doc-1', parseNewDocument(card(), NOW), NOW);

  it('starts at revision 1 and version 1', () => {
    expect(base()).toMatchObject({ revision: 1, version: 1, archivedAt: null, tenantId: A });
    expect(revisionOf(base(), ACTOR, NOW)).toEqual({
      tenantId: A,
      documentId: 'doc-1',
      revision: 1,
      issuedOn: null,
      expiresOn: '2027-03-31',
      documentNumber: null,
      actorId: ACTOR,
      at: NOW.toISOString(),
    });
  });

  it('patches, renews and archives with version checks', () => {
    const later = new Date('2026-10-07T00:00:00.000Z');
    const patched = applyPatch(base(), { title: 'Otro' }, 1, later);
    expect(patched).toMatchObject({ title: 'Otro', version: 2, revision: 1 });
    expect(patched.updatedAt).toBe(later.toISOString());
    const renewed = applyRenewal(
      patched,
      { issuedOn: null, expiresOn: '2029-01-01', documentNumber: null },
      2,
      later,
    );
    expect(renewed).toMatchObject({ revision: 2, version: 3, expiresOn: '2029-01-01' });
    const archived = applyArchive(renewed, 3, later);
    expect(archived.archivedAt).toBe(later.toISOString());
    expect(archived.version).toBe(4);
    expect(() => applyPatch(base(), { title: 'x' }, 2, NOW)).toThrow(DocumentError);
    expect(() =>
      applyRenewal(base(), { issuedOn: null, expiresOn: null, documentNumber: null }, 9, NOW),
    ).toThrow(expect.objectContaining({ code: 'stale_version' }));
    for (const work of [
      () => applyPatch(archived, { title: 'x' }, 4, NOW),
      () =>
        applyRenewal(archived, { issuedOn: null, expiresOn: null, documentNumber: null }, 4, NOW),
      () => applyArchive(archived, 4, NOW),
    ])
      expect(work).toThrow(expect.objectContaining({ code: 'immutable' }));
  });
});

describe('InMemoryDocumentStore', () => {
  it('is tenant scoped, ordered by expiry then id, and filters', async () => {
    const { svc, store } = service();
    const mk = (over: Record<string, unknown>) => svc.create(A, ACTOR, card(over));
    const d1 = await mk({ expiresOn: '2026-12-01', title: 'uno' });
    const d2 = await mk({ expiresOn: '2026-10-01', title: 'dos' });
    const d3 = await mk({ typeCode: 'other', expiresOn: null, title: 'tres' });
    const d4 = await mk({ expiresOn: '2026-10-20', ownerId: 'veh-2', title: 'cuatro' });
    const e1 = await svc.create(A, ACTOR, {
      ownerType: 'employee',
      ownerId: 'emp-1',
      typeCode: 'medical_exam',
      title: 'Examen',
      expiresOn: '2027-01-01',
    });
    const other = await svc.create(B, ACTOR, card({ title: 'ajeno' }));
    expect((await svc.list(A)).items.map((d) => d.id)).toEqual([d2.id, d4.id, d1.id, e1.id, d3.id]);
    expect((await svc.list(A)).total).toBe(5);
    expect((await svc.list(B)).items.map((d) => d.id)).toEqual([other.id]);
    expect(await store.find(B, d1.id)).toBeNull();
    expect((await svc.list(A, { ownerType: 'employee' })).items.map((d) => d.id)).toEqual([e1.id]);
    expect(
      (await svc.list(A, { ownerType: 'vehicle', ownerId: 'veh-2' })).items.map((d) => d.id),
    ).toEqual([d4.id]);
    expect((await svc.list(A, { typeCode: 'other' })).items.map((d) => d.id)).toEqual([d3.id]);
    expect((await svc.list(A, { status: 'expired' })).items.map((d) => d.id)).toEqual([d2.id]);
    expect((await svc.list(A, { status: 'expiring' })).items.map((d) => d.id)).toEqual([d4.id]);
    expect((await svc.list(A, { status: 'valid' })).items.map((d) => d.id)).toEqual([
      d1.id,
      e1.id,
      d3.id,
    ]);
    expect((await svc.list(A, { limit: 2, offset: 1 })).items.map((d) => d.id)).toEqual([
      d4.id,
      d1.id,
    ]);
    await svc.archive(A, d2.id, 1);
    expect((await svc.list(A, { status: 'expired' })).total).toBe(0);
    expect((await svc.list(A, { status: 'expired', includeArchived: true })).total).toBe(1);
  });

  it('labels the history from the rows read, even when a renewal lands between the reads', async () => {
    const inner = new InMemoryDocumentStore();
    let renewNext: (() => Promise<unknown>) | undefined;
    const store: DocumentStore = {
      find: (...args) => inner.find(...args),
      list: (...args) => inner.list(...args),
      insert: (...args) => inner.insert(...args),
      replace: (...args) => inner.replace(...args),
      revisions: async (...args) => {
        const action = renewNext;
        renewNext = undefined;
        if (action) await action();
        return inner.revisions(...args);
      },
    };
    const { svc } = service({ store });
    const doc = await svc.create(A, ACTOR, card({ expiresOn: '2026-12-01' }));
    renewNext = () => svc.renew(A, ACTOR, doc.id, 1, { expiresOn: '2027-12-01' });
    const history = await svc.history(A, doc.id);
    expect(history.items.map((r) => [r.revision, r.status])).toEqual([
      [2, 'valid'],
      [1, 'replaced'],
    ]);
    const older = await svc.history(A, doc.id, { limit: 1, offset: 1 });
    expect(older.items.map((r) => [r.revision, r.status])).toEqual([[1, 'replaced']]);
    expect((await svc.history(A, doc.id, { limit: 1, offset: 5 })).items).toEqual([]);
  });

  it('returns defensive copies', async () => {
    const { svc, store } = service();
    const doc = await svc.create(A, ACTOR, card());
    const found = (await store.find(A, doc.id)) as { title: string };
    found.title = 'mutated';
    expect((await svc.get(A, doc.id)).title).toBe('Tarjeta de circulación');
  });
});

describe('DocumentService', () => {
  it('creates, reads, edits, renews keeping history, and archives', async () => {
    const { svc } = service();
    const created = await svc.create(
      A,
      ACTOR,
      card({ issuedOn: '2025-03-31', documentNumber: 'tc-1' }),
    );
    expect(created).toMatchObject({ id: 'doc-1', revision: 1, version: 1, documentNumber: 'TC-1' });
    expect(await svc.get(A, created.id)).toEqual(created);
    const edited = await svc.update(A, created.id, 1, { title: 'Renombrada', notes: 'ok' });
    expect(edited).toMatchObject({ title: 'Renombrada', notes: 'ok', version: 2, revision: 1 });
    const renewed = await svc.renew(A, ACTOR, created.id, 2, {
      issuedOn: '2026-10-01',
      expiresOn: '2028-03-31',
    });
    expect(renewed).toMatchObject({
      revision: 2,
      version: 3,
      issuedOn: '2026-10-01',
      expiresOn: '2028-03-31',
      title: 'Renombrada',
    });
    const history = await svc.history(A, created.id);
    expect(history.total).toBe(2);
    expect(history.items.map((r) => [r.revision, r.expiresOn, r.status, r.documentNumber])).toEqual(
      [
        [2, '2028-03-31', 'valid', null],
        [1, '2027-03-31', 'replaced', 'TC-1'],
      ],
    );
    expect(
      (await svc.history(A, created.id, { limit: 1, offset: 1 })).items.map((r) => r.revision),
    ).toEqual([1]);
    const archived = await svc.archive(A, created.id, 3);
    expect(archived.archivedAt).not.toBeNull();
    await rejects(() => svc.update(A, created.id, 4, { title: 'x' }), 'immutable');
    await rejects(
      () => svc.renew(A, ACTOR, created.id, 4, { expiresOn: '2030-01-01' }),
      'immutable',
    );
    expect((await svc.history(A, created.id)).total).toBe(2);
  });

  it('derives expiry from the service clock', async () => {
    const { svc, setNow } = service();
    const doc = await svc.create(A, ACTOR, card({ expiresOn: '2026-10-20' }));
    expect(svc.expiry(doc)).toEqual({ status: 'expiring', daysToExpiry: 14 });
    setNow(new Date('2026-10-20T23:59:59.000Z'));
    expect(svc.expiry(doc)).toEqual({ status: 'expiring', daysToExpiry: 0 });
    setNow(new Date('2026-10-21T00:00:00.000Z'));
    expect(svc.expiry(doc)).toEqual({ status: 'expired', daysToExpiry: -1 });
    expect((await svc.history(A, doc.id)).items[0]?.status).toBe('expired');
    expect((await svc.list(A, { status: 'expired' })).total).toBe(1);
  });

  it('answers not_found for unknown and foreign ids, for every operation', async () => {
    const { svc } = service();
    const doc = await svc.create(A, ACTOR, card());
    for (const id of ['nope', doc.id])
      for (const work of [
        () => svc.get(B, id),
        () => svc.update(B, id, 1, { title: 'x' }),
        () => svc.renew(B, ACTOR, id, 1, { expiresOn: '2030-01-01' }),
        () => svc.archive(B, id, 1),
        () => svc.history(B, id),
      ])
        await rejects(work, 'not_found');
    expect((await svc.get(A, doc.id)).version).toBe(1);
  });

  it('rejects invalid input uniformly', async () => {
    const { svc } = service();
    await rejects(() => svc.create('bad id', ACTOR, card()), 'invalid_input');
    await rejects(() => svc.create(A, 'bad id', card()), 'invalid_input');
    await rejects(() => svc.get(A, 5), 'invalid_input');
    await rejects(() => svc.update(A, 'doc-1', 'x', { title: 'x' }), 'invalid_input');
    await rejects(() => svc.list('bad id'), 'invalid_input');
    for (const query of [
      { limit: 0 },
      { limit: 101 },
      { offset: -1 },
      { offset: 1.5 },
      { ownerType: 'policy' },
      { ownerId: 'veh-1' },
      { ownerType: 'vehicle', ownerId: 'a b' },
      { status: 'replaced' },
      { includeArchived: 'yes' },
      { typeCode: 'nope' },
      { ownerType: 'employee', typeCode: 'registration_card' },
    ])
      await rejects(() => svc.list(A, query), 'invalid_input');
    expect((await svc.list(A, { typeCode: 'registration_card' })).total).toBe(0);
    await rejects(() => svc.renew(A, 'bad id', 'doc-1', 1, {}), 'invalid_input');
  });

  it('detects stale versions, also when the write loses a race', async () => {
    const { svc, store } = service();
    const doc = await svc.create(A, ACTOR, card());
    await svc.update(A, doc.id, 1, { title: 'v2' });
    await rejects(() => svc.update(A, doc.id, 1, { title: 'x' }), 'stale_version');
    await rejects(
      () => svc.renew(A, ACTOR, doc.id, 1, { expiresOn: '2030-01-01' }),
      'stale_version',
    );
    await rejects(() => svc.archive(A, doc.id, 1), 'stale_version');
    const racing: DocumentStore = {
      insert: (d, r) => store.insert(d, r),
      find: (t, i) => store.find(t, i),
      list: (t, f, w) => store.list(t, f, w),
      revisions: (t, d, w) => store.revisions(t, d, w),
      replace: async () => false,
    };
    const lost = service({ store: racing });
    const created = await lost.svc.create(A, ACTOR, card());
    await rejects(() => lost.svc.update(A, created.id, 1, { title: 'x' }), 'stale_version');
    const vanishing: DocumentStore = {
      ...racing,
      find: (() => {
        let calls = 0;
        return async (t: string, i: string) => (++calls === 1 ? store.find(t, i) : null);
      })(),
    };
    await rejects(
      () => service({ store: vanishing }).svc.update(A, doc.id, 1, { title: 'x' }),
      'not_found',
    );
  });

  it('checks the owner on create and renew, but not on edits or archive', async () => {
    const calls: string[] = [];
    let live = true;
    const owners: DocumentOwnerGate = {
      assertLive: async (tenantId, ownerType, ownerId) => {
        calls.push(`${tenantId}:${ownerType}:${ownerId}`);
        if (!live) throw new DocumentError('invalid_owner', 'owner_id');
      },
    };
    const { svc } = service({ owners });
    const doc = await svc.create(A, ACTOR, card());
    expect(calls).toEqual([`${A}:vehicle:veh-1`]);
    live = false;
    await rejects(
      () => svc.create(A, ACTOR, card({ ownerId: 'veh-9' })),
      'invalid_owner',
      'owner_id',
    );
    await rejects(
      () => svc.renew(A, ACTOR, doc.id, 1, { expiresOn: '2030-01-01' }),
      'invalid_owner',
      'owner_id',
    );
    await svc.update(A, doc.id, 1, { title: 'still editable' });
    await svc.archive(A, doc.id, 2);
    expect(calls).toHaveLength(3);
    // Invalid input and stale versions never reach the owner module.
    calls.length = 0;
    await rejects(() => svc.create(A, ACTOR, card({ title: '' })), 'invalid_input');
    const fresh = await (async () => {
      live = true;
      return svc.create(A, ACTOR, card());
    })();
    calls.length = 0;
    await rejects(
      () => svc.renew(A, ACTOR, fresh.id, 7, { expiresOn: '2030-01-01' }),
      'stale_version',
    );
    await rejects(() => svc.renew(A, ACTOR, fresh.id, 1, {}), 'invalid_input');
    expect(calls).toEqual([]);
  });

  it('uses random ids and the real clock by default', async () => {
    const svc = new DocumentService(new InMemoryDocumentStore());
    const doc = await svc.create(A, ACTOR, card({ expiresOn: '2100-01-01' }));
    expect(doc.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(svc.expiry(doc).status).toBe('valid');
  });
});
