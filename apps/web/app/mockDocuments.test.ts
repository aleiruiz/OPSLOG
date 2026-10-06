import { describe, expect, it } from 'vitest';
import { demoDocuments, makeDocument } from '../documents/fixtures';
import { createMockApi, demoCredentials } from './mockApi';
import { createMockDocumentStore } from './mockDocuments';
import type { DocumentInput } from './types';

const input: DocumentInput = {
  ownerType: 'vehicle',
  ownerId: 'veh-001',
  typeCode: 'registration_card',
  title: '  Tarjeta   nueva ',
  issuedOn: '2026-01-10',
  expiresOn: '2027-01-10',
  documentNumber: 'tc 9-1',
};
const failure = (status: number, code: string) => ({ ok: false, error: { status, code } });

describe('mock document store', () => {
  it('lists by expiry date (documents without one last), filters, hides archived rows and pages with a cursor', async () => {
    const { port } = createMockDocumentStore([
      ...demoDocuments(28),
      makeDocument({ id: 'doc-sin', title: 'Sin vencimiento', typeCode: 'other', expiresOn: null }),
      makeDocument({ id: 'doc-arch', archivedAt: '2026-09-30T00:00:00.000Z' }),
    ]);
    const first = await port.list({ limit: 25 });
    expect(first).toMatchObject({ ok: true, value: { total: 29, nextCursor: 'mock:25' } });
    const all = await port.list({ limit: 100 });
    const items = all.ok ? all.value.items : [];
    const dated = items.filter((item) => item.expiresOn !== null).map((item) => item.expiresOn);
    expect(dated).toEqual([...dated].sort());
    expect(items.at(-1)?.id).toBe('doc-sin');
    const second = await port.list({ limit: 25, cursor: 'mock:25' });
    expect(second.ok && second.value.items).toHaveLength(4);
    expect(second.ok && second.value.nextCursor).toBeNull();
    const withArchived = await port.list({ includeArchived: 'true', limit: 100 });
    expect(withArchived.ok && withArchived.value.total).toBe(30);
    const expired = await port.list({ status: 'expired', limit: 100 });
    expect(expired.ok && expired.value.items.every((item) => item.status === 'expired')).toBe(true);
    const employees = await port.list({ ownerType: 'employee', limit: 100 });
    expect(
      employees.ok && employees.value.items.every((item) => item.ownerType === 'employee'),
    ).toBe(true);
    const one = await port.list({ ownerType: 'vehicle', ownerId: 'veh-001', typeCode: 'other' });
    expect(one.ok && one.value.total).toBe(1);
  });

  it('derives the status from the clock: the last day is expiring, the next one expired', async () => {
    const store = createMockDocumentStore(
      [
        makeDocument({ id: 'a', expiresOn: '2026-10-06' }),
        makeDocument({ id: 'b', expiresOn: '2026-10-05' }),
        makeDocument({ id: 'c', expiresOn: '2026-11-05' }),
        makeDocument({ id: 'd', expiresOn: '2026-11-06' }),
        makeDocument({ id: 'e', expiresOn: null }),
      ],
      { now: () => new Date('2026-10-06T23:59:59.000Z') },
    );
    const status = async (id: string) => {
      const result = await store.port.get(id);
      return result.ok ? [result.value.status, result.value.daysToExpiry] : null;
    };
    expect(await status('a')).toEqual(['expiring', 0]);
    expect(await status('b')).toEqual(['expired', -1]);
    expect(await status('c')).toEqual(['expiring', 30]);
    expect(await status('d')).toEqual(['valid', 31]);
    expect(await status('e')).toEqual(['valid', null]);
  });

  it('rejects malformed queries with a uniform 400', async () => {
    const { port } = createMockDocumentStore();
    for (const query of [
      { limit: 10 as 25 },
      { cursor: 'otro' },
      { ownerType: 'robot' as 'vehicle' },
      { ownerId: 'veh-001' },
      { ownerType: 'vehicle' as const, ownerId: 'no válido' },
      { typeCode: 'No Valido' },
      { status: 'volando' as 'valid' },
      { includeArchived: 'si' as 'true' },
    ])
      expect(await port.list(query)).toMatchObject(failure(400, 'bad_request'));
  });

  it('creates a document with version 1, normalized text and revision 1, and records the first revision', async () => {
    const store = createMockDocumentStore([]);
    const created = await store.port.create(input);
    expect(created).toMatchObject({
      ok: true,
      value: {
        title: 'Tarjeta nueva',
        documentNumber: 'TC 9-1',
        notes: null,
        revision: 1,
        version: 1,
        status: 'valid',
        archivedAt: null,
      },
    });
    const id = created.ok ? created.value.id : '';
    const history = await store.port.history(id);
    expect(history).toMatchObject({ ok: true, value: { total: 1 } });
    expect(history.ok && history.value.items[0]).toMatchObject({
      revision: 1,
      status: 'valid',
      actorId: 'user-admin',
    });
  });

  it('accepts a document without expiry only for a type that allows it', async () => {
    const store = createMockDocumentStore([]);
    expect(
      await store.port.create({
        ownerType: 'vehicle',
        ownerId: 'veh-001',
        typeCode: 'ownership_title',
        title: 'Título',
        notes: ' Original ',
      }),
    ).toMatchObject({ ok: true, value: { expiresOn: null, status: 'valid', notes: 'Original' } });
    expect(
      await store.port.create({
        ownerType: 'vehicle',
        ownerId: 'veh-001',
        typeCode: 'registration_card',
        title: 'Sin vencimiento',
      }),
    ).toMatchObject(failure(400, 'bad_request'));
  });

  it.each([
    ['unknown key', { extra: 1 }],
    ['owner type', { ownerType: 'robot' }],
    ['type of the other owner', { typeCode: 'medical_exam' }],
    ['unknown type', { typeCode: 'nada' }],
    ['owner id', { ownerId: 'no válido' }],
    ['missing title', { title: undefined }],
    ['long title', { title: 'x'.repeat(81) }],
    ['control characters in notes', { notes: 'a\nb' }],
    ['numeric notes', { notes: 7 }],
    ['future issue date', { issuedOn: '2026-10-07' }],
    ['impossible date', { expiresOn: '2027-02-30' }],
    ['expiry before issue', { issuedOn: '2026-10-01', expiresOn: '2026-09-30' }],
    ['expiry out of range', { expiresOn: '2101-01-01' }],
    ['numeric document number', { documentNumber: 12 }],
    ['malformed document number', { documentNumber: '***' }],
  ])('rejects a creation with a bad %s with a uniform 400', async (_name, change) => {
    const { port } = createMockDocumentStore([]);
    expect(await port.create({ ...input, ...change } as unknown as DocumentInput)).toMatchObject(
      failure(400, 'bad_request'),
    );
  });

  it('refuses an owner that is unknown, archived or of the wrong kind with the same 422 on field owner_id', async () => {
    const api = createMockApi();
    await api.auth.login(demoCredentials.admin);
    await api.vehicles.archive('veh-002', 1);
    const answers = [
      await api.documents.create({ ...input, ownerId: 'veh-inexistente' }),
      await api.documents.create({ ...input, ownerId: 'veh-002' }),
      await api.documents.create({
        ownerType: 'employee',
        ownerId: 'emp-999',
        typeCode: 'medical_exam',
        title: 'Examen',
        expiresOn: '2027-01-01',
      }),
    ];
    for (const answer of answers)
      expect(answer).toMatchObject({
        ok: false,
        error: { status: 422, code: 'invalid_owner', fieldErrors: [{ field: 'owner_id' }] },
      });
    expect(
      await api.documents.create({
        ownerType: 'employee',
        ownerId: 'emp-001',
        typeCode: 'medical_exam',
        title: 'Examen',
        expiresOn: '2027-01-01',
      }),
    ).toMatchObject({ ok: true });
  });

  it('edits only the title and the notes, and bumps the version', async () => {
    const store = createMockDocumentStore([makeDocument({ notes: 'Antes' })]);
    expect(
      await store.port.update('doc-001', { version: 1, title: ' Nuevo   título ' }),
    ).toMatchObject({
      ok: true,
      value: { title: 'Nuevo título', notes: 'Antes', version: 2, revision: 1 },
    });
    expect(await store.port.update('doc-001', { version: 2, notes: null })).toMatchObject({
      ok: true,
      value: { notes: null, version: 3 },
    });
    expect(await store.port.update('doc-001', { version: 3, notes: ' Hola ' })).toMatchObject({
      ok: true,
      value: { notes: 'Hola' },
    });
    expect(await store.port.update('doc-001', { version: 1, title: 'Viejo' })).toMatchObject(
      failure(409, 'stale_version'),
    );
    expect(await store.port.update('doc-999', { version: 1, title: 'x' })).toMatchObject(
      failure(404, 'not_found'),
    );
    for (const patch of [
      { version: 4 },
      { version: 0, title: 'x' },
      { version: 4, title: '' },
      { version: 4, title: 7 },
      { version: 4, notes: 7 },
      { version: 4, notes: 'a\nb' },
      { version: 4, expiresOn: '2030-01-01' },
    ])
      expect(
        await store.port.update('doc-001', patch as unknown as { version: number }),
      ).toMatchObject(failure(400, 'bad_request'));
  });

  it('renews by appending a revision and keeps the earlier ones; the older one reads as replaced', async () => {
    const store = createMockDocumentStore([makeDocument()]);
    const renewed = await store.port.renew('doc-001', {
      version: 1,
      issuedOn: '2026-10-01',
      expiresOn: '2028-10-01',
      documentNumber: 'tc-2',
    });
    expect(renewed).toMatchObject({
      ok: true,
      value: { revision: 2, version: 2, expiresOn: '2028-10-01', documentNumber: 'TC-2' },
    });
    const history = await store.port.history('doc-001');
    expect(history.ok && history.value.items.map((item) => [item.revision, item.status])).toEqual([
      [2, 'valid'],
      [1, 'replaced'],
    ]);
    expect(history.ok && history.value.items[1]?.expiresOn).toBe('2027-11-20');
    // A required expiry cannot be dropped by a renewal.
    expect(await store.port.renew('doc-001', { version: 2 })).toMatchObject(
      failure(400, 'bad_request'),
    );
    expect(
      await store.port.renew('doc-001', { version: 1, expiresOn: '2029-01-01' }),
    ).toMatchObject(failure(409, 'stale_version'));
    expect(await store.port.renew('doc-999', { version: 1 })).toMatchObject(
      failure(404, 'not_found'),
    );
    expect(
      await store.port.renew('doc-001', {
        version: 2,
        expiresOn: '2029-01-01',
        extra: 1,
      } as never),
    ).toMatchObject(failure(400, 'bad_request'));
  });

  it('renews documents whose expiry is optional with or without one, and refuses a dead owner', async () => {
    const live = new Set(['veh-001']);
    const store = createMockDocumentStore(
      [
        makeDocument({ typeCode: 'other', expiresOn: null, issuedOn: null, documentNumber: null }),
        makeDocument({ id: 'doc-002', ownerId: 'veh-009' }),
      ],
      { isLiveOwner: (_type, id) => live.has(id) },
    );
    expect(await store.port.renew('doc-001', { version: 1 })).toMatchObject({
      ok: true,
      value: { revision: 2, expiresOn: null },
    });
    expect(
      await store.port.renew('doc-002', { version: 1, expiresOn: '2030-01-01' }),
    ).toMatchObject(failure(422, 'invalid_owner'));
  });

  it('archives once, then treats the document as read-only (409 immutable)', async () => {
    const store = createMockDocumentStore([makeDocument()]);
    expect(await store.port.archive('doc-001', 0)).toMatchObject(failure(400, 'bad_request'));
    expect(await store.port.archive('doc-001', 9)).toMatchObject(failure(409, 'stale_version'));
    expect(await store.port.archive('doc-001', 1)).toMatchObject({
      ok: true,
      value: { archivedAt: '2026-10-06T12:00:00.000Z', version: 2 },
    });
    expect(await store.port.archive('doc-001', 2)).toMatchObject(failure(409, 'immutable'));
    expect(await store.port.update('doc-001', { version: 2, title: 'x' })).toMatchObject(
      failure(409, 'immutable'),
    );
    expect(
      await store.port.renew('doc-001', { version: 2, expiresOn: '2030-01-01' }),
    ).toMatchObject(failure(409, 'immutable'));
    expect(await store.port.archive('doc-999', 1)).toMatchObject(failure(404, 'not_found'));
    // The history of an archived document is kept.
    expect(await store.port.history('doc-001')).toMatchObject({ ok: true, value: { total: 1 } });
  });

  it('pages the history of a seeded multi-revision document, newest first, and validates its query', async () => {
    const store = createMockDocumentStore([
      makeDocument({ revision: 3, issuedOn: null, expiresOn: null }),
    ]);
    const first = await store.port.history('doc-001', { limit: 25 });
    expect(first.ok && first.value.items.map((item) => item.revision)).toEqual([3, 2, 1]);
    expect(first.ok && first.value.items.every((item) => item.expiresOn === null)).toBe(true);
    const tail = await store.port.history('doc-001', { limit: 25, cursor: 'mock:2' });
    expect(tail.ok && tail.value.items.map((item) => item.revision)).toEqual([1]);
    const middle = await store.port.history('doc-001', { limit: 25, cursor: 'mock:1' });
    expect(middle.ok && middle.value.nextCursor).toBeNull();
    expect(await store.port.history('doc-001', { limit: 10 as 25 })).toMatchObject(
      failure(400, 'bad_request'),
    );
    expect(await store.port.history('doc-001', { cursor: 'otro' })).toMatchObject(
      failure(400, 'bad_request'),
    );
    expect(await store.port.history('doc-999')).toMatchObject(failure(404, 'not_found'));
  });

  it('lets the controls change or archive a document as another actor, and ignores unknown ids', async () => {
    const store = createMockDocumentStore([makeDocument()]);
    store.changeExternally('doc-001', { title: 'Cambiado' });
    store.changeExternally('doc-999', { title: 'Nada' });
    expect(store.snapshot()[0]).toMatchObject({ title: 'Cambiado', version: 2 });
    store.archiveExternally('doc-001');
    store.archiveExternally('doc-999');
    expect(store.snapshot()[0]).toMatchObject({
      archivedAt: '2026-10-06T12:00:00.000Z',
      version: 3,
    });
  });

  it('is guarded by the role of the mock API (viewer reads, only the admin archives)', async () => {
    const api = createMockApi();
    await api.auth.login(demoCredentials.viewer);
    expect(await api.documents.list()).toMatchObject({ ok: true });
    expect(await api.documents.create(input)).toMatchObject(failure(403, 'forbidden'));
    expect(await api.documents.update('doc-001', { version: 1, title: 'x' })).toMatchObject(
      failure(403, 'forbidden'),
    );
    expect(await api.documents.renew('doc-001', { version: 1 })).toMatchObject(
      failure(403, 'forbidden'),
    );
    await api.auth.login(demoCredentials.dispatch);
    expect(await api.documents.archive('doc-001', 1)).toMatchObject(failure(403, 'forbidden'));
    api.controls.expireSession();
    expect(await api.documents.get('doc-001')).toMatchObject(failure(401, 'unauthorized'));
  });
});
