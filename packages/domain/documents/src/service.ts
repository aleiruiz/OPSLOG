import { randomUUID } from 'node:crypto';
import { DocumentError } from './errors.js';
import {
  type DocumentFilter,
  type DocumentOwnerGate,
  type DocumentSlice,
  type DocumentStore,
  type DocumentWindow,
} from './ports.js';
import {
  applyArchive,
  applyPatch,
  applyRenewal,
  expiryFilterOf,
  expiryOf,
  newDocument,
  revisionOf,
  revisionStatus,
} from './rules.js';
import {
  DEFAULT_LIST_LIMIT,
  DOCUMENT_OWNER_TYPES,
  MAX_LIST_LIMIT,
  isDocumentStatus,
  isDocumentType,
  isOwnerType,
  type Document,
  type DocumentOwnerType,
  type DocumentRevision,
  type Expiry,
  type RevisionStatus,
} from './types.js';
import {
  dateOf,
  invalid,
  isInteger,
  parseDocumentPatch,
  parseNewDocument,
  parseRenewal,
  requireOpaqueId,
  requireVersion,
} from './validation.js';

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
