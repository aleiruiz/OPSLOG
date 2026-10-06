import { randomUUID } from 'node:crypto';

/**
 * Owners of a document in this slice (BRD §12.4: exactly one primary entity). Vehicles and
 * employees only; policies, work orders and incidents arrive with their own modules.
 */
export const DOCUMENT_OWNER_TYPES = ['vehicle', 'employee'] as const;
export type DocumentOwnerType = (typeof DOCUMENT_OWNER_TYPES)[number];

export type ExpiryRule = 'required' | 'optional';

/**
 * Built-in document types per owner (BRD §8.2 seed examples). A company-defined catalog with
 * mandatory flags and alert days belongs to FLT-SETTINGS; until it exists these constants are the
 * catalog. `required` types must carry an expiry date. Insurance is not a document type: policies
 * are a separate model (slice 2). Identity and licence copies are not offered (they need PII
 * handling, BRD §12.5).
 */
export const DOCUMENT_TYPES: Readonly<
  Record<DocumentOwnerType, Readonly<Record<string, ExpiryRule>>>
> = {
  vehicle: {
    registration_card: 'required',
    technical_inspection: 'required',
    transport_permit: 'required',
    municipal_authorization: 'required',
    ownership_title: 'optional',
    other: 'optional',
  },
  employee: {
    medical_exam: 'required',
    training_certificate: 'optional',
    driving_course: 'optional',
    other: 'optional',
  },
};

/** Days before the last valid day in which a document is `expiring` (BRD §15 default: 30). */
export const EXPIRING_WINDOW_DAYS = 30;

/**
 * Derived status of a document as of a day: `expired` after its last valid day (inclusive),
 * `expiring` from `EXPIRING_WINDOW_DAYS` before it, `valid` otherwise (also when it has no expiry).
 * Never stored: it changes with the calendar.
 */
export type DocumentStatus = 'valid' | 'expiring' | 'expired';
export const DOCUMENT_STATUSES = ['valid', 'expiring', 'expired'] as const;
/** Status of a revision in the history: the current one is derived, older ones are `replaced`. */
export type RevisionStatus = DocumentStatus | 'replaced';

export const isOwnerType = (value: unknown): value is DocumentOwnerType =>
  typeof value === 'string' && (DOCUMENT_OWNER_TYPES as readonly string[]).includes(value);
export const isDocumentStatus = (value: unknown): value is DocumentStatus =>
  typeof value === 'string' && (DOCUMENT_STATUSES as readonly string[]).includes(value);
export const isDocumentType = (ownerType: DocumentOwnerType, value: unknown): value is string =>
  typeof value === 'string' && Object.hasOwn(DOCUMENT_TYPES[ownerType], value);

export type DocumentErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'stale_version'
  | 'immutable'
  /** The owner is unknown, of another tenant or archived (all indistinguishable). */
  | 'invalid_owner';

/** Which input is invalid (`invalid_owner`). Never a value. */
export type DocumentConflictField = 'owner_id';

export class DocumentError extends Error {
  public constructor(
    public readonly code: DocumentErrorCode,
    public readonly field?: DocumentConflictField,
  ) {
    super(`Document request rejected: ${code}`);
    this.name = 'DocumentError';
  }
}

export const MAX_LIST_LIMIT = 100;
export const DEFAULT_LIST_LIMIT = 25;
export const MIN_DATE = '1950-01-01';
export const MAX_EXPIRY_DATE = '2100-12-31';
/** Sort and filter key of a document without expiry: it sorts after every real date. */
export const NO_EXPIRY_KEY = '9999-12-31';

/**
 * One immutable snapshot of the validity data of a document (BR-025). Renewing appends a new one;
 * an older snapshot is never edited, so the original data stays as it was recorded.
 */
export interface DocumentRevision {
  readonly tenantId: string;
  readonly documentId: string;
  /** 1 for the first record, +1 on every renewal. */
  readonly revision: number;
  /** `YYYY-MM-DD`. */
  readonly issuedOn: string | null;
  /** `YYYY-MM-DD`: the last valid day, inclusive. */
  readonly expiresOn: string | null;
  readonly documentNumber: string | null;
  readonly actorId: string;
  readonly at: string;
}

export interface Document {
  readonly id: string;
  /** Company (tenant) that owns the row. Never taken from caller input. */
  readonly tenantId: string;
  readonly ownerType: DocumentOwnerType;
  readonly ownerId: string;
  readonly typeCode: string;
  readonly title: string;
  readonly notes: string | null;
  /** Number of the current revision; the validity fields below are a copy of that revision. */
  readonly revision: number;
  readonly issuedOn: string | null;
  readonly expiresOn: string | null;
  readonly documentNumber: string | null;
  /** Optimistic concurrency token: starts at 1, +1 on every change. */
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

const invalid = (): never => {
  throw new DocumentError('invalid_input');
};

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const TITLE = /^[^\u0000-\u001f\u007f]{1,80}$/u;
const NOTES = /^[^\u0000-\u001f\u007f]{1,500}$/u;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DOCUMENT_NUMBER = /^[A-Z0-9][A-Z0-9 ./-]{0,39}$/;

export const requireOpaqueId = (value: unknown): string =>
  typeof value === 'string' && OPAQUE_ID.test(value) ? value : invalid();

const isInteger = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

export const requireVersion = (value: unknown): number =>
  isInteger(value, 1, 2_147_483_646) ? value : invalid();

export const dateOf = (now: Date): string => now.toISOString().slice(0, 10);

/** The calendar day `days` after `day` (`YYYY-MM-DD`, UTC arithmetic). */
export const addDays = (day: string, days: number): string =>
  dateOf(new Date(Date.parse(`${day}T00:00:00.000Z`) + days * 86_400_000));

const DAY_MS = 86_400_000;

function normalizeDate(value: unknown, min: string, max: string): string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return invalid();
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || dateOf(parsed) !== value || value < min || value > max)
    return invalid();
  return value;
}

const trimmed = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

function normalizeTitle(value: unknown): string {
  const text = trimmed(value).replace(/\s+/g, ' ');
  return TITLE.test(text) ? text : invalid();
}

function normalizeNotes(value: unknown): string {
  const text = trimmed(value);
  return NOTES.test(text) ? text : invalid();
}

export function normalizeDocumentNumber(value: unknown): string {
  const text = trimmed(value).toUpperCase().replace(/\s+/g, ' ');
  return DOCUMENT_NUMBER.test(text) ? text : invalid();
}

type Fields = Readonly<Record<string, unknown>>;

function asFields(input: unknown, allowed: readonly string[]): Fields {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return invalid();
  const record = input as Fields;
  return Object.keys(record).some((key) => !allowed.includes(key)) ? invalid() : record;
}

const has = (fields: Fields, key: string): boolean => Object.hasOwn(fields, key);

const optional = <T>(fields: Fields, key: string, parse: (value: unknown) => T): T | null =>
  has(fields, key) && fields[key] !== null && fields[key] !== undefined ? parse(fields[key]) : null;

export const REVISION_FIELDS = ['issuedOn', 'expiresOn', 'documentNumber'] as const;
export const CREATE_FIELDS = [
  'ownerType',
  'ownerId',
  'typeCode',
  'title',
  'notes',
  ...REVISION_FIELDS,
] as const;
export const UPDATE_FIELDS = ['title', 'notes'] as const;

/** The validity data of a revision, validated and normalized. */
export interface RevisionData {
  readonly issuedOn: string | null;
  readonly expiresOn: string | null;
  readonly documentNumber: string | null;
}

/** Validates the validity fields: dates are real calendar days, expiry is not before issue. */
function parseRevisionData(fields: Fields, now: Date, rule: ExpiryRule): RevisionData {
  const issuedOn = optional(fields, 'issuedOn', (value) =>
    normalizeDate(value, MIN_DATE, dateOf(now)),
  );
  const expiresOn = optional(fields, 'expiresOn', (value) =>
    normalizeDate(value, MIN_DATE, MAX_EXPIRY_DATE),
  );
  if (rule === 'required' && expiresOn === null) return invalid();
  if (issuedOn !== null && expiresOn !== null && expiresOn < issuedOn) return invalid();
  return {
    issuedOn,
    expiresOn,
    documentNumber: optional(fields, 'documentNumber', normalizeDocumentNumber),
  };
}

export interface NewDocumentData {
  readonly ownerType: DocumentOwnerType;
  readonly ownerId: string;
  readonly typeCode: string;
  readonly title: string;
  readonly notes: string | null;
  readonly revision: RevisionData;
}

/** Validates the data of a new document. Unknown properties are rejected. */
export function parseNewDocument(input: unknown, now: Date): NewDocumentData {
  const fields = asFields(input, CREATE_FIELDS);
  if (['ownerType', 'ownerId', 'typeCode', 'title'].some((key) => !has(fields, key)))
    return invalid();
  const ownerType = fields['ownerType'];
  if (!isOwnerType(ownerType)) return invalid();
  const typeCode = fields['typeCode'];
  if (!isDocumentType(ownerType, typeCode)) return invalid();
  return {
    ownerType,
    ownerId: requireOpaqueId(fields['ownerId']),
    typeCode,
    title: normalizeTitle(fields['title']),
    notes: optional(fields, 'notes', normalizeNotes),
    revision: parseRevisionData(fields, now, DOCUMENT_TYPES[ownerType][typeCode] as ExpiryRule),
  };
}

/** Validates a renewal: the same validity fields as a new document, for an existing one. */
export function parseRenewal(
  input: unknown,
  now: Date,
  ownerType: DocumentOwnerType,
  typeCode: string,
): RevisionData {
  const fields = asFields(input, REVISION_FIELDS);
  return parseRevisionData(fields, now, DOCUMENT_TYPES[ownerType][typeCode] as ExpiryRule);
}

export interface DocumentPatch {
  readonly title?: string;
  readonly notes?: string | null;
}

/** Only the title and the notes are editable in place; at least one field is required. */
export function parseDocumentPatch(input: unknown): DocumentPatch {
  const fields = asFields(input, UPDATE_FIELDS);
  if (Object.keys(fields).length === 0) return invalid();
  return {
    ...(has(fields, 'title') ? { title: normalizeTitle(fields['title']) } : {}),
    ...(has(fields, 'notes')
      ? { notes: fields['notes'] === null ? null : normalizeNotes(fields['notes']) }
      : {}),
  };
}

// ---- expiry -----------------------------------------------------------------------------------

export interface Expiry {
  readonly status: DocumentStatus;
  /** Whole days from `today` to the last valid day (0 on that day, negative after); null without expiry. */
  readonly daysToExpiry: number | null;
}

/** Sort and filter key of an expiry date. */
export const expiryKeyOf = (expiresOn: string | null): string => expiresOn ?? NO_EXPIRY_KEY;

/**
 * Derives the status as of `today` (`YYYY-MM-DD`). The last valid day is inclusive: on that day the
 * document is `expiring` with 0 days left, the next day it is `expired`.
 */
export function expiryOf(expiresOn: string | null, today: string): Expiry {
  if (expiresOn === null) return { status: 'valid', daysToExpiry: null };
  const days = Math.round(
    (Date.parse(`${expiresOn}T00:00:00.000Z`) - Date.parse(`${today}T00:00:00.000Z`)) / DAY_MS,
  );
  return {
    status: days < 0 ? 'expired' : days <= EXPIRING_WINDOW_DAYS ? 'expiring' : 'valid',
    daysToExpiry: days,
  };
}

/** Status of a revision in the history: older revisions are `replaced`, the current one is derived. */
export function revisionStatus(
  revision: Pick<DocumentRevision, 'revision' | 'expiresOn'>,
  currentRevision: number,
  today: string,
): RevisionStatus {
  return revision.revision === currentRevision
    ? expiryOf(revision.expiresOn, today).status
    : 'replaced';
}

/** The range of `expiryKeyOf` values that matches a derived status as of `today`. */
export interface ExpiryFilter {
  readonly status: DocumentStatus;
  /** `today`. */
  readonly from: string;
  /** `today` plus `EXPIRING_WINDOW_DAYS`. */
  readonly until: string;
}

export const expiryFilterOf = (status: DocumentStatus, today: string): ExpiryFilter => ({
  status,
  from: today,
  until: addDays(today, EXPIRING_WINDOW_DAYS),
});

/** The same rule as `expiryOf`, expressed over a key (used by the in-memory store). */
export function matchesExpiry(key: string, filter: ExpiryFilter): boolean {
  if (filter.status === 'expired') return key < filter.from;
  if (filter.status === 'expiring') return key >= filter.from && key <= filter.until;
  return key > filter.until;
}

// ---- pure state changes -----------------------------------------------------------------------

/** Archived documents are read-only. */
function assertEditable(document: Document): void {
  if (document.archivedAt !== null) throw new DocumentError('immutable');
}

function assertVersion(document: Document, expectedVersion: number): void {
  if (document.version !== expectedVersion) throw new DocumentError('stale_version');
}

const touched = (document: Document, now: Date): Pick<Document, 'version' | 'updatedAt'> => ({
  version: document.version + 1,
  updatedAt: now.toISOString(),
});

export function revisionOf(document: Document, actorId: string, now: Date): DocumentRevision {
  return {
    tenantId: document.tenantId,
    documentId: document.id,
    revision: document.revision,
    issuedOn: document.issuedOn,
    expiresOn: document.expiresOn,
    documentNumber: document.documentNumber,
    actorId,
    at: now.toISOString(),
  };
}

/** The first record of a document: revision 1, version 1, not archived. */
export function newDocument(
  tenantId: string,
  id: string,
  data: NewDocumentData,
  now: Date,
): Document {
  return {
    id,
    tenantId,
    ownerType: data.ownerType,
    ownerId: data.ownerId,
    typeCode: data.typeCode,
    title: data.title,
    notes: data.notes,
    revision: 1,
    ...data.revision,
    version: 1,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    archivedAt: null,
  };
}

export function applyPatch(
  document: Document,
  patch: DocumentPatch,
  expectedVersion: number,
  now: Date,
): Document {
  assertEditable(document);
  assertVersion(document, expectedVersion);
  return { ...document, ...patch, ...touched(document, now) };
}

/** BR-025: a renewal is a new revision; the previous one stays in the history untouched. */
export function applyRenewal(
  document: Document,
  data: RevisionData,
  expectedVersion: number,
  now: Date,
): Document {
  assertEditable(document);
  assertVersion(document, expectedVersion);
  return { ...document, ...data, revision: document.revision + 1, ...touched(document, now) };
}

/** Soft delete (BR-009): the row and its revisions stay, hidden from default listings and read-only. */
export function applyArchive(document: Document, expectedVersion: number, now: Date): Document {
  assertEditable(document);
  assertVersion(document, expectedVersion);
  return { ...document, archivedAt: now.toISOString(), ...touched(document, now) };
}

// ---- store port -------------------------------------------------------------------------------

export interface DocumentFilter {
  readonly ownerType?: DocumentOwnerType;
  readonly ownerId?: string;
  readonly typeCode?: string;
  readonly expiry?: ExpiryFilter;
  readonly includeArchived: boolean;
}
export interface DocumentWindow {
  readonly limit: number;
  readonly offset: number;
}
export interface DocumentSlice {
  readonly items: readonly Document[];
  /** Number of documents matching the filter, not only the window. */
  readonly total: number;
}
export interface DocumentRevisionSlice {
  readonly items: readonly DocumentRevision[];
  readonly total: number;
}

/**
 * Persistence port. Every method is tenant-scoped: a document of another tenant is simply absent.
 * `insert` and `replace` also write the revision snapshot, atomically with the document.
 */
export interface DocumentStore {
  insert(document: Document, revision: DocumentRevision): Promise<void>;
  find(tenantId: string, id: string): Promise<Document | null>;
  /** Ordered by expiry date (documents without expiry last), then id. */
  list(tenantId: string, filter: DocumentFilter, window: DocumentWindow): Promise<DocumentSlice>;
  /** Atomic compare-and-set: writes `next` (and the optional new revision) only while the stored version is `expectedVersion`; false otherwise. */
  replace(next: Document, expectedVersion: number, revision?: DocumentRevision): Promise<boolean>;
  /** Newest revision first. */
  revisions(
    tenantId: string,
    documentId: string,
    window: DocumentWindow,
  ): Promise<DocumentRevisionSlice>;
}

/** Plain code-unit order, so every store lists in the same order. */
const compareKeys = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const storeKey = (tenantId: string, id: string): string =>
  `${tenantId.length}:${tenantId}${id.length}:${id}`;

/** In-memory double of the port. Each method is synchronous inside, so every operation is atomic. */
export class InMemoryDocumentStore implements DocumentStore {
  private readonly documents = new Map<string, Document>();
  private readonly revisionRows: DocumentRevision[] = [];

  public async insert(document: Document, revision: DocumentRevision): Promise<void> {
    this.documents.set(storeKey(document.tenantId, document.id), structuredClone(document));
    this.revisionRows.push(structuredClone(revision));
  }

  public async find(tenantId: string, id: string): Promise<Document | null> {
    const found = this.documents.get(storeKey(tenantId, id));
    return found ? structuredClone(found) : null;
  }

  public async list(
    tenantId: string,
    filter: DocumentFilter,
    window: DocumentWindow,
  ): Promise<DocumentSlice> {
    const matching = [...this.documents.values()]
      .filter(
        (document) =>
          document.tenantId === tenantId &&
          (filter.includeArchived || document.archivedAt === null) &&
          (filter.ownerType === undefined || document.ownerType === filter.ownerType) &&
          (filter.ownerId === undefined || document.ownerId === filter.ownerId) &&
          (filter.typeCode === undefined || document.typeCode === filter.typeCode) &&
          (filter.expiry === undefined ||
            matchesExpiry(expiryKeyOf(document.expiresOn), filter.expiry)),
      )
      .sort(
        (a, b) =>
          compareKeys(expiryKeyOf(a.expiresOn), expiryKeyOf(b.expiresOn)) ||
          compareKeys(a.id, b.id),
      );
    return {
      items: matching
        .slice(window.offset, window.offset + window.limit)
        .map((document) => structuredClone(document)),
      total: matching.length,
    };
  }

  public async replace(
    next: Document,
    expectedVersion: number,
    revision?: DocumentRevision,
  ): Promise<boolean> {
    const key = storeKey(next.tenantId, next.id);
    const current = this.documents.get(key);
    if (current?.version !== expectedVersion) return false;
    this.documents.set(key, structuredClone(next));
    if (revision) this.revisionRows.push(structuredClone(revision));
    return true;
  }

  public async revisions(
    tenantId: string,
    documentId: string,
    window: DocumentWindow,
  ): Promise<DocumentRevisionSlice> {
    const all = this.revisionRows
      .filter((row) => row.tenantId === tenantId && row.documentId === documentId)
      .sort((a, b) => b.revision - a.revision);
    return {
      items: all
        .slice(window.offset, window.offset + window.limit)
        .map((row) => structuredClone(row)),
      total: all.length,
    };
  }
}

// ---- service ----------------------------------------------------------------------------------

/**
 * Port to the owner modules. `assertLive` resolves only when `ownerId` is a live (not archived)
 * owner of that type in `tenantId`; unknown, foreign and archived owners are indistinguishable:
 * it throws `DocumentError('invalid_owner', 'owner_id')`. Other failures propagate unchanged.
 */
export interface DocumentOwnerGate {
  assertLive(tenantId: string, ownerType: DocumentOwnerType, ownerId: string): Promise<void>;
}

export interface DocumentListQuery {
  readonly ownerType?: unknown;
  readonly ownerId?: unknown;
  readonly typeCode?: unknown;
  readonly status?: unknown;
  readonly includeArchived?: unknown;
  readonly limit?: unknown;
  readonly offset?: unknown;
}

export interface DocumentHistoryQuery {
  readonly limit?: unknown;
  readonly offset?: unknown;
}

export interface DocumentServiceOptions {
  /**
   * Checks that the owner of a new document, or of a renewal, is a live owner of the tenant.
   * Without it the owner is not checked (only for tests of this package); the platform
   * composition always supplies it.
   */
  readonly owners?: DocumentOwnerGate;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

function windowOf(query: DocumentHistoryQuery): DocumentWindow {
  const limit = query.limit === undefined ? DEFAULT_LIST_LIMIT : query.limit;
  const offset = query.offset === undefined ? 0 : query.offset;
  if (!isInteger(limit, 1, MAX_LIST_LIMIT) || !isInteger(offset, 0, 1_000_000)) return invalid();
  return { limit, offset };
}

/**
 * Document use cases over the store port. Authorization, authentication and audit belong to the
 * caller (the composition); this class enforces the domain rules. The tenant is always an
 * argument taken from the server-side session, never part of the input being validated.
 */
export class DocumentService {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly owners: DocumentOwnerGate | undefined;

  public constructor(
    private readonly store: DocumentStore,
    options: DocumentServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
    this.owners = options.owners;
  }

  /** The document of this tenant, or `not_found` (also for ids of other tenants). */
  private async load(tenantId: string, id: unknown): Promise<Document> {
    const document = await this.store.find(requireOpaqueId(tenantId), requireOpaqueId(id));
    if (document?.tenantId !== tenantId) throw new DocumentError('not_found');
    return document;
  }

  /** Writes `next`; a lost race reads as `stale_version` (or `not_found` when the row is gone). */
  private async commit(
    next: Document,
    expectedVersion: number,
    revision?: DocumentRevision,
  ): Promise<Document> {
    if (await this.store.replace(next, expectedVersion, revision)) return next;
    const current = await this.store.find(next.tenantId, next.id);
    throw new DocumentError(current ? 'stale_version' : 'not_found');
  }

  public async create(tenantId: string, actorId: string, input: unknown): Promise<Document> {
    requireOpaqueId(tenantId);
    requireOpaqueId(actorId);
    const now = this.now();
    const data = parseNewDocument(input, now);
    await this.owners?.assertLive(tenantId, data.ownerType, data.ownerId);
    const document = newDocument(tenantId, this.newId(), data, now);
    await this.store.insert(document, revisionOf(document, actorId, now));
    return document;
  }

  public get(tenantId: string, id: unknown): Promise<Document> {
    return this.load(tenantId, id);
  }

  public async list(tenantId: string, query: DocumentListQuery = {}): Promise<DocumentSlice> {
    requireOpaqueId(tenantId);
    const window = windowOf(query);
    if (query.ownerType !== undefined && !isOwnerType(query.ownerType)) return invalid();
    if (query.ownerId !== undefined && query.ownerType === undefined) return invalid();
    if (query.status !== undefined && !isDocumentStatus(query.status)) return invalid();
    if (query.includeArchived !== undefined && typeof query.includeArchived !== 'boolean')
      return invalid();
    const filter: DocumentFilter = {
      includeArchived: query.includeArchived ?? false,
      ...(query.ownerType === undefined ? {} : { ownerType: query.ownerType }),
      ...(query.ownerId === undefined ? {} : { ownerId: requireOpaqueId(query.ownerId) }),
      ...(query.typeCode === undefined
        ? {}
        : { typeCode: this.requireListType(query.ownerType, query.typeCode) }),
      ...(query.status === undefined
        ? {}
        : { expiry: expiryFilterOf(query.status, dateOf(this.now())) }),
    };
    return this.store.list(tenantId, filter, window);
  }

  /** A type filter is a code of the catalog (of the owner type when given, of any otherwise). */
  private requireListType(ownerType: DocumentOwnerType | undefined, value: unknown): string {
    const owners = ownerType === undefined ? DOCUMENT_OWNER_TYPES : [ownerType];
    return owners.some((owner) => isDocumentType(owner, value)) ? (value as string) : invalid();
  }

  public async update(
    tenantId: string,
    id: unknown,
    expectedVersion: unknown,
    input: unknown,
  ): Promise<Document> {
    const now = this.now();
    const patch = parseDocumentPatch(input);
    const version = requireVersion(expectedVersion);
    const current = await this.load(tenantId, id);
    return this.commit(applyPatch(current, patch, version, now), version);
  }

  /** BR-025 / FR-133: appends a revision with the new validity data and keeps the previous ones. */
  public async renew(
    tenantId: string,
    actorId: string,
    id: unknown,
    expectedVersion: unknown,
    input: unknown,
  ): Promise<Document> {
    requireOpaqueId(actorId);
    const now = this.now();
    const version = requireVersion(expectedVersion);
    const current = await this.load(tenantId, id);
    const data = parseRenewal(input, now, current.ownerType, current.typeCode);
    // Cheap checks first: a stale or archived document never reaches the owner module.
    applyRenewal(current, data, version, now);
    await this.owners?.assertLive(tenantId, current.ownerType, current.ownerId);
    const next = applyRenewal(current, data, version, now);
    return this.commit(next, version, revisionOf(next, actorId, now));
  }

  public async archive(tenantId: string, id: unknown, expectedVersion: unknown): Promise<Document> {
    const version = requireVersion(expectedVersion);
    const current = await this.load(tenantId, id);
    return this.commit(applyArchive(current, version, this.now()), version);
  }

  /** Revisions, newest first, each with its status as of today. */
  public async history(
    tenantId: string,
    id: unknown,
    query: DocumentHistoryQuery = {},
  ): Promise<{
    readonly items: readonly (DocumentRevision & { readonly status: RevisionStatus })[];
    readonly total: number;
  }> {
    const document = await this.load(tenantId, id);
    const window = windowOf(query);
    const slice = await this.store.revisions(tenantId, document.id, window);
    const today = dateOf(this.now());
    // The current revision comes from the rows themselves (newest first, so the first row of the
    // first page), not from a second read of the document that a concurrent renewal could outdate.
    // Later pages only hold older rows, which are all replaced.
    const current =
      window.offset === 0 ? (slice.items[0]?.revision ?? 0) : Number.POSITIVE_INFINITY;
    return {
      total: slice.total,
      items: slice.items.map((row) => ({ ...row, status: revisionStatus(row, current, today) })),
    };
  }

  /** Derived expiry status as of today (UTC date of the service clock). */
  public expiry(document: Pick<Document, 'expiresOn'>): Expiry {
    return expiryOf(document.expiresOn, dateOf(this.now()));
  }
}
