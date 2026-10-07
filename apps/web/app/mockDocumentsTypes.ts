import type { Document, DocumentsPort } from './types';

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
