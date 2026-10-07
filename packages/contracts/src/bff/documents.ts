import type { ISODateTime, Page } from '../index.js';
import type { BffRouteDefinition } from './shared.js';

export const BFF_DOCUMENT_OWNER_TYPES = ['vehicle', 'employee'] as const;
export type BffDocumentOwnerType = (typeof BFF_DOCUMENT_OWNER_TYPES)[number];

/** Derived from the expiry date and the server clock; never stored. */
export const BFF_DOCUMENT_STATUSES = ['valid', 'expiring', 'expired'] as const;
export type BffDocumentStatus = (typeof BFF_DOCUMENT_STATUSES)[number];

/** Status of a revision in the history: the current one is derived, older ones are `replaced`. */
export type BffDocumentRevisionStatus = BffDocumentStatus | 'replaced';

/**
 * A document of a vehicle or an employee: metadata only (files arrive with the files module). The
 * company is implicit (the session's); `version` is the concurrency token. The validity fields
 * (`issuedOn`, `expiresOn`, `documentNumber`) belong to the current `revision`; renewing appends a
 * revision and keeps the earlier ones.
 */
export interface BffDocument {
  readonly id: string;
  readonly ownerType: BffDocumentOwnerType;
  readonly ownerId: string;
  /** Catalog code, valid for the owner type (for example `registration_card` or `medical_exam`). */
  readonly typeCode: string;
  readonly title: string;
  readonly notes: string | null;
  readonly revision: number;
  /** `YYYY-MM-DD`. */
  readonly issuedOn: string | null;
  /** `YYYY-MM-DD`; the last valid day, inclusive. */
  readonly expiresOn: string | null;
  readonly documentNumber: string | null;
  readonly status: BffDocumentStatus;
  /** Whole days to the last valid day (0 on that day, negative once expired); `null` without expiry. */
  readonly daysToExpiry: number | null;
  readonly version: number;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
  readonly archivedAt: ISODateTime | null;
}

/**
 * Creating a document. Types that must expire (for example `registration_card`) require
 * `expiresOn`; `expiresOn` is never before `issuedOn`, and `issuedOn` is not in the future.
 */
export interface BffDocumentInput {
  readonly ownerType: BffDocumentOwnerType;
  readonly ownerId: string;
  readonly typeCode: string;
  readonly title: string;
  readonly notes?: string | null;
  readonly issuedOn?: string | null;
  readonly expiresOn?: string | null;
  readonly documentNumber?: string | null;
}

/** Only the title and the notes can be edited in place; at least one besides `version`. */
export interface BffDocumentPatch {
  readonly version: number;
  readonly title?: string;
  readonly notes?: string | null;
}

/** A renewal: the validity data of the new revision. The owner, type and title stay. */
export interface BffDocumentRenewal {
  readonly version: number;
  readonly issuedOn?: string | null;
  readonly expiresOn?: string | null;
  readonly documentNumber?: string | null;
}

export interface BffDocumentsQuery {
  readonly limit?: 25 | 50 | 100;
  readonly cursor?: string;
  readonly ownerType?: BffDocumentOwnerType;
  /** Needs `ownerType`. */
  readonly ownerId?: string;
  readonly typeCode?: string;
  readonly status?: BffDocumentStatus;
  /** `true` to include archived documents (default: hidden). */
  readonly includeArchived?: 'true' | 'false';
}

export interface BffDocumentRevision {
  readonly revision: number;
  readonly issuedOn: string | null;
  readonly expiresOn: string | null;
  readonly documentNumber: string | null;
  readonly status: BffDocumentRevisionStatus;
  /** `user-<subject>`: the only identifier of a person in the row. */
  readonly actorId: string;
  readonly at: ISODateTime;
}

export interface BffDocumentHistoryQuery {
  readonly limit?: 25 | 50 | 100;
  readonly cursor?: string;
}

/** Request and response types of the documents routes. */
export interface DocumentsRouteTypes {
  'documents.list': { query?: BffDocumentsQuery; response: Page<BffDocument> };
  'documents.create': { body: BffDocumentInput; response: BffDocument };
  'documents.get': { params: { id: string }; response: BffDocument };
  'documents.update': { params: { id: string }; body: BffDocumentPatch; response: BffDocument };
  'documents.renew': { params: { id: string }; body: BffDocumentRenewal; response: BffDocument };
  'documents.archive': { params: { id: string }; body: { version: number }; response: BffDocument };
  'documents.history': {
    params: { id: string };
    query?: BffDocumentHistoryQuery;
    response: Page<BffDocumentRevision>;
  };
}

export const DOCUMENTS_ROUTES = {
  'documents.list': { method: 'GET', path: ['api', 'documents'], kind: 'session', status: 200 },
  'documents.create': {
    method: 'POST',
    path: ['api', 'documents'],
    kind: 'session-csrf',
    status: 201,
  },
  'documents.get': {
    method: 'GET',
    path: ['api', 'documents', ':id'],
    kind: 'session',
    status: 200,
  },
  'documents.update': {
    method: 'PUT',
    path: ['api', 'documents', ':id'],
    kind: 'session-csrf',
    status: 200,
  },
  'documents.renew': {
    method: 'POST',
    path: ['api', 'documents', ':id', 'renew'],
    kind: 'session-csrf',
    status: 200,
  },
  'documents.archive': {
    method: 'POST',
    path: ['api', 'documents', ':id', 'archive'],
    kind: 'session-csrf',
    status: 200,
  },
  'documents.history': {
    method: 'GET',
    path: ['api', 'documents', ':id', 'history'],
    kind: 'session',
    status: 200,
  },
} as const satisfies Record<keyof DocumentsRouteTypes, BffRouteDefinition>;
