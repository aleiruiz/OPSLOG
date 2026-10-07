import { DocumentError } from './errors.js';
import {
  EXPIRING_WINDOW_DAYS,
  NO_EXPIRY_KEY,
  type Document,
  type DocumentPatch,
  type DocumentRevision,
  type DocumentStatus,
  type Expiry,
  type ExpiryFilter,
  type NewDocumentData,
  type RevisionData,
  type RevisionStatus,
} from './types.js';
import { DAY_MS, addDays } from './validation.js';

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
