import {
  type Document,
  type DocumentOwnerType,
  type DocumentRevision,
  type ExpiryFilter,
} from './types.js';

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

/**
 * Port to the owner modules. `assertLive` resolves only when `ownerId` is a live (not archived)
 * owner of that type in `tenantId`; unknown, foreign and archived owners are indistinguishable:
 * it throws `DocumentError('invalid_owner', 'owner_id')`. Other failures propagate unchanged.
 */
export interface DocumentOwnerGate {
  assertLive(tenantId: string, ownerType: DocumentOwnerType, ownerId: string): Promise<void>;
}
