import {
  type DocumentFilter,
  type DocumentRevisionSlice,
  type DocumentSlice,
  type DocumentStore,
  type DocumentWindow,
} from './ports.js';
import { expiryKeyOf, matchesExpiry } from './rules.js';
import { type Document, type DocumentRevision } from './types.js';

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
