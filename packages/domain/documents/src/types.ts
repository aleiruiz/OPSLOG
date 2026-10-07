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

/** The validity data of a revision, validated and normalized. */
export interface RevisionData {
  readonly issuedOn: string | null;
  readonly expiresOn: string | null;
  readonly documentNumber: string | null;
}

export interface NewDocumentData {
  readonly ownerType: DocumentOwnerType;
  readonly ownerId: string;
  readonly typeCode: string;
  readonly title: string;
  readonly notes: string | null;
  readonly revision: RevisionData;
}

export interface DocumentPatch {
  readonly title?: string;
  readonly notes?: string | null;
}

export interface Expiry {
  readonly status: DocumentStatus;
  /** Whole days from `today` to the last valid day (0 on that day, negative after); null without expiry. */
  readonly daysToExpiry: number | null;
}

/** The range of `expiryKeyOf` values that matches a derived status as of `today`. */
export interface ExpiryFilter {
  readonly status: DocumentStatus;
  /** `today`. */
  readonly from: string;
  /** `today` plus `EXPIRING_WINDOW_DAYS`. */
  readonly until: string;
}
