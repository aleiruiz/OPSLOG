import { BFF_DOCUMENT_OWNER_TYPES, BFF_DOCUMENT_STATUSES } from '@opslog/contracts';
import { demoDocuments } from '../documents/fixtures';
import { NOTES, OPAQUE_ID, TITLE, normalizeText, todayOf, typeInfo } from '../documents/rules';
import {
  NOW,
  NO_EXPIRY_KEY,
  badRequest,
  conflict,
  derive,
  invalidOwner,
  notFound,
  ok,
  onlyKeys,
  parseValidity,
  seedRevisions,
  validVersion,
} from './mockDocumentsSupport';
import type { MockDocumentStore } from './mockDocumentsTypes';
import type {
  Document,
  DocumentInput,
  DocumentListQuery,
  DocumentOwnerType,
  DocumentPatch,
  DocumentRenewal,
  DocumentRevision,
  DocumentsPort,
  Page,
} from './types';

export type { MockDocumentStore };

export function createMockDocumentStore(
  seed: readonly Document[] = demoDocuments(),
  options: {
    now?: () => Date;
    /** Whether the owner exists in the company and is not archived (the backend refuses any other). */
    isLiveOwner?: (ownerType: DocumentOwnerType, ownerId: string) => boolean;
    actorId?: () => string;
  } = {},
): MockDocumentStore {
  const now = options.now ?? (() => new Date(NOW));
  const isLiveOwner = options.isLiveOwner ?? (() => true);
  const actorId = options.actorId ?? (() => 'user-admin');
  const today = () => todayOf(now());
  const withState = (document: Document): Document => ({
    ...document,
    ...derive(document, today()),
  });

  let rows: Document[] = seed.map((document) => ({ ...document }));
  let sequence = rows.length;
  // Earlier revisions of a seeded document are synthetic: one year apart, oldest first.
  const revisions = seedRevisions(rows);

  const index = (id: string) => rows.findIndex((document) => document.id === id);
  const replace = (id: string, next: Document) => {
    rows = rows.map((document) => (document.id === id ? next : document));
    return next;
  };
  const bump = (document: Document, change: Partial<Document>): Document => ({
    ...document,
    ...change,
    version: document.version + 1,
    updatedAt: NOW,
  });
  const requiresExpiry = (document: Pick<Document, 'ownerType' | 'typeCode'>) =>
    typeInfo(document.ownerType, document.typeCode)?.expiry === 'required';

  const port: DocumentsPort = {
    list: async (query: DocumentListQuery = {}) => {
      const limit = query.limit ?? 25;
      const offset =
        query.cursor === undefined ? 0 : Number(/^mock:(\d+)$/.exec(query.cursor)?.[1]);
      if (
        ![25, 50, 100].includes(limit) ||
        !Number.isSafeInteger(offset) ||
        (query.ownerType !== undefined && !BFF_DOCUMENT_OWNER_TYPES.includes(query.ownerType)) ||
        (query.ownerId !== undefined &&
          (query.ownerType === undefined || !OPAQUE_ID.test(query.ownerId))) ||
        (query.typeCode !== undefined && !/^[a-z_]{1,40}$/.test(query.typeCode)) ||
        (query.status !== undefined && !BFF_DOCUMENT_STATUSES.includes(query.status)) ||
        (query.includeArchived !== undefined && !['true', 'false'].includes(query.includeArchived))
      )
        return badRequest();
      const key = (document: Document) => document.expiresOn ?? NO_EXPIRY_KEY;
      const matches = rows
        .map(withState)
        .filter(
          (document) =>
            (query.includeArchived === 'true' || document.archivedAt === null) &&
            (query.ownerType === undefined || document.ownerType === query.ownerType) &&
            (query.ownerId === undefined || document.ownerId === query.ownerId) &&
            (query.typeCode === undefined || document.typeCode === query.typeCode) &&
            (query.status === undefined || document.status === query.status),
        )
        .sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a.id < b.id ? -1 : 1));
      const next = offset + limit;
      const page: Page<Document> = {
        items: matches.slice(offset, next),
        nextCursor: next < matches.length ? `mock:${next}` : null,
        total: matches.length,
        sort: { field: 'expiresOn', direction: 'asc' },
      };
      return ok(page);
    },
    get: async (id) => {
      const found = rows[index(id)];
      return found ? ok(withState(found)) : notFound();
    },
    create: async (input: DocumentInput) => {
      const fields = input as unknown as Readonly<Record<string, unknown>>;
      const { ownerType, ownerId, typeCode, title, notes } = fields;
      const text = (value: unknown) => (typeof value === 'string' ? normalizeText(value) : null);
      const cleanTitle = text(title);
      const cleanNotes =
        notes === undefined || notes === null
          ? null
          : typeof notes === 'string'
            ? notes.trim()
            : undefined;
      if (
        !onlyKeys(fields, [
          'ownerType',
          'ownerId',
          'typeCode',
          'title',
          'notes',
          'issuedOn',
          'expiresOn',
          'documentNumber',
        ]) ||
        typeof ownerType !== 'string' ||
        !BFF_DOCUMENT_OWNER_TYPES.includes(ownerType as DocumentOwnerType) ||
        typeof typeCode !== 'string' ||
        typeof ownerId !== 'string' ||
        !OPAQUE_ID.test(ownerId) ||
        cleanTitle === null ||
        !TITLE.test(cleanTitle) ||
        cleanNotes === undefined ||
        (cleanNotes !== null && !NOTES.test(cleanNotes))
      )
        return badRequest();
      const kind = typeInfo(ownerType as DocumentOwnerType, typeCode);
      if (!kind) return badRequest();
      const validity = parseValidity(fields, kind.expiry === 'required', today());
      if (validity === null) return badRequest();
      if (!isLiveOwner(ownerType as DocumentOwnerType, ownerId)) return invalidOwner();
      sequence += 1;
      const id = `doc-nuevo-${sequence}`;
      const base: Document = {
        id,
        ownerType: ownerType as DocumentOwnerType,
        ownerId,
        typeCode,
        title: cleanTitle,
        notes: cleanNotes,
        revision: 1,
        ...validity,
        status: 'valid',
        daysToExpiry: null,
        version: 1,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
      };
      rows = [...rows, base];
      revisions.set(id, [{ revision: 1, ...validity, actorId: actorId(), at: NOW }]);
      return ok(withState(base));
    },
    update: async (id, patch: DocumentPatch) => {
      const { version, ...rest } = patch as unknown as Record<string, unknown>;
      const current = rows[index(id)];
      if (!current) return notFound();
      const title = rest['title'] === undefined ? undefined : normalizeText(String(rest['title']));
      const rawNotes = rest['notes'];
      const notes =
        rawNotes === undefined || rawNotes === null ? rawNotes : String(rawNotes).trim();
      if (
        !validVersion(version) ||
        Object.keys(rest).length === 0 ||
        !onlyKeys(rest, ['title', 'notes']) ||
        (title !== undefined && !TITLE.test(title)) ||
        (typeof notes === 'string' && !NOTES.test(notes)) ||
        (rest['title'] !== undefined && typeof rest['title'] !== 'string') ||
        (rawNotes !== undefined && rawNotes !== null && typeof rawNotes !== 'string')
      )
        return badRequest();
      if (current.archivedAt !== null) return conflict('immutable');
      if (current.version !== version) return conflict('stale_version');
      return ok(
        withState(
          replace(
            id,
            bump(current, {
              ...(title === undefined ? {} : { title }),
              ...(notes === undefined ? {} : { notes }),
            }),
          ),
        ),
      );
    },
    renew: async (id, renewal: DocumentRenewal) => {
      const { version, ...rest } = renewal as unknown as Record<string, unknown>;
      const current = rows[index(id)];
      if (!current) return notFound();
      const validity = onlyKeys(rest, ['issuedOn', 'expiresOn', 'documentNumber'])
        ? parseValidity(rest, requiresExpiry(current), today())
        : null;
      if (!validVersion(version) || validity === null) return badRequest();
      if (current.archivedAt !== null) return conflict('immutable');
      if (current.version !== version) return conflict('stale_version');
      if (!isLiveOwner(current.ownerType, current.ownerId)) return invalidOwner();
      const revision = current.revision + 1;
      revisions.set(id, [
        ...(revisions.get(id) ?? []),
        { revision, ...validity, actorId: actorId(), at: NOW },
      ]);
      return ok(withState(replace(id, bump(current, { revision, ...validity }))));
    },
    archive: async (id, version) => {
      const current = rows[index(id)];
      if (!current) return notFound();
      if (!validVersion(version)) return badRequest();
      if (current.archivedAt !== null) return conflict('immutable');
      if (current.version !== version) return conflict('stale_version');
      return ok(withState(replace(id, bump(current, { archivedAt: NOW }))));
    },
    history: async (id, query = {}) => {
      const limit = query.limit ?? 25;
      const offset =
        query.cursor === undefined ? 0 : Number(/^mock:(\d+)$/.exec(query.cursor)?.[1]);
      const current = rows[index(id)];
      if (!current) return notFound();
      if (![25, 50, 100].includes(limit) || !Number.isSafeInteger(offset)) return badRequest();
      const all: DocumentRevision[] = [...(revisions.get(id) ?? [])]
        .sort((a, b) => b.revision - a.revision)
        .map((entry) => ({
          revision: entry.revision,
          issuedOn: entry.issuedOn,
          expiresOn: entry.expiresOn,
          documentNumber: entry.documentNumber,
          status:
            entry.revision === current.revision
              ? derive({ ...current, expiresOn: entry.expiresOn }, today()).status
              : ('replaced' as const),
          actorId: entry.actorId,
          at: entry.at,
        }));
      const next = offset + limit;
      return ok({
        items: all.slice(offset, next),
        nextCursor: next < all.length ? `mock:${next}` : null,
        total: all.length,
        sort: { field: 'revision', direction: 'desc' as const },
      } satisfies Page<DocumentRevision>);
    },
  };

  return {
    port,
    changeExternally: (id, change) => {
      const current = rows[index(id)];
      if (current) replace(id, bump(current, change));
    },
    archiveExternally: (id) => {
      const current = rows[index(id)];
      if (current) replace(id, bump(current, { archivedAt: NOW }));
    },
    snapshot: () => rows.map(withState),
  };
}
