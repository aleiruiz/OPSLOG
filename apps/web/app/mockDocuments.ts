import type { ApiError } from '@opslog/contracts';
import { BFF_DOCUMENT_OWNER_TYPES, BFF_DOCUMENT_STATUSES } from '@opslog/contracts';
import { demoDocuments } from '../documents/fixtures';
import {
  EXPIRING_WINDOW_DAYS,
  MAX_EXPIRY_DATE,
  MIN_DATE,
  NOTES,
  OPAQUE_ID,
  REFERENCE_NUMBER,
  TITLE,
  isDateBetween,
  normalizeReference,
  normalizeText,
  todayOf,
  typeInfo,
} from '../documents/rules';
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
  Result,
} from './types';

/**
 * In-memory documents with the semantics of the real backend (`packages/domain/documents`): optimistic versions
 * (409 `stale_version`), read-only archived documents (409 `immutable`), a status derived from the expiry date and
 * the server clock, immutable revisions appended by renewals, a live owner of the company checked on create and
 * renew (a uniform 422 `invalid_owner`), and a uniform 400/404. Permissions are enforced by the caller (`mockApi`).
 */
export interface MockDocumentStore {
  readonly port: DocumentsPort;
  /** Another actor edits the document on the server: its version moves on, so the caller's copy is stale. */
  changeExternally(id: string, change: Partial<Pick<Document, 'title' | 'notes'>>): void;
  /** Another actor archives the document on the server. */
  archiveExternally(id: string): void;
  snapshot(): readonly Document[];
}

const NOW = '2026-10-06T12:00:00.000Z';
const DAY_MS = 86_400_000;
const NO_EXPIRY_KEY = '9999-12-31';
let correlation = 0;

function failure(
  status: ApiError['status'],
  code: string,
  message: string,
  field?: string,
): Result<never> {
  correlation += 1;
  return {
    ok: false,
    error: {
      code,
      status,
      message,
      correlationId: `corr-mock-document-${correlation}`,
      ...(field === undefined ? {} : { fieldErrors: [{ field, code, message }] }),
    },
  };
}
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const badRequest = () => failure(400, 'bad_request', 'Invalid request');
const notFound = () => failure(404, 'not_found', 'Resource not found');
const invalidOwner = () => failure(422, 'invalid_owner', 'Unprocessable request', 'owner_id');
const conflict = (code: 'stale_version' | 'immutable') => failure(409, code, 'Conflict');

const validVersion = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 2_147_483_646;

/** Derived state as of the server clock: never stored. */
function derive(document: Document, today: string): Pick<Document, 'status' | 'daysToExpiry'> {
  if (document.expiresOn === null) return { status: 'valid', daysToExpiry: null };
  const days = Math.round(
    (Date.parse(`${document.expiresOn}T00:00:00.000Z`) - Date.parse(`${today}T00:00:00.000Z`)) /
      DAY_MS,
  );
  return {
    status: days < 0 ? 'expired' : days <= EXPIRING_WINDOW_DAYS ? 'expiring' : 'valid',
    daysToExpiry: days,
  };
}

interface Validity {
  readonly issuedOn: string | null;
  readonly expiresOn: string | null;
  readonly documentNumber: string | null;
}

interface StoredRevision extends Validity {
  readonly revision: number;
  readonly actorId: string;
  readonly at: string;
}

/** Validates the validity fields of a creation or a renewal; `null` when anything is invalid. */
function parseValidity(
  fields: Readonly<Record<string, unknown>>,
  required: boolean,
  today: string,
): Validity | null {
  const date = (key: string, max: string): string | null | undefined => {
    const value = fields[key];
    if (value === undefined || value === null) return null;
    return typeof value === 'string' && isDateBetween(value, MIN_DATE, max) ? value : undefined;
  };
  const issuedOn = date('issuedOn', today);
  const expiresOn = date('expiresOn', MAX_EXPIRY_DATE);
  if (issuedOn === undefined || expiresOn === undefined) return null;
  if (required && expiresOn === null) return null;
  if (issuedOn !== null && expiresOn !== null && expiresOn < issuedOn) return null;
  const raw = fields['documentNumber'];
  let documentNumber: string | null = null;
  if (raw !== undefined && raw !== null) {
    if (typeof raw !== 'string') return null;
    documentNumber = normalizeReference(raw);
    if (!REFERENCE_NUMBER.test(documentNumber)) return null;
  }
  return { issuedOn, expiresOn, documentNumber };
}

const onlyKeys = (fields: Readonly<Record<string, unknown>>, allowed: readonly string[]) =>
  Object.keys(fields).every((key) => allowed.includes(key));

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
  const revisions = new Map<string, StoredRevision[]>(
    rows.map((document) => [
      document.id,
      Array.from({ length: document.revision }, (_, index): StoredRevision => {
        const revision = index + 1;
        const back = (document.revision - revision) * 365;
        const move = (day: string | null) =>
          day === null
            ? null
            : new Date(Date.parse(`${day}T00:00:00.000Z`) - back * DAY_MS)
                .toISOString()
                .slice(0, 10);
        return {
          revision,
          issuedOn: move(document.issuedOn),
          expiresOn: move(document.expiresOn),
          documentNumber: document.documentNumber,
          actorId: 'user-admin',
          at: document.createdAt,
        };
      }),
    ]),
  );

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
