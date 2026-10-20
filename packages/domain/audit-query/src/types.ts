/** Page sizes the audit listing accepts (SPECS §8). */
export const AUDIT_PAGE_SIZES = [25, 50, 100] as const;
export type AuditPageSize = (typeof AUDIT_PAGE_SIZES)[number];
/** Without a range the listing covers the last 30 days; a range is never longer than 366 days. */
export const AUDIT_DEFAULT_RANGE_DAYS = 30;
export const AUDIT_MAX_RANGE_DAYS = 366;

export type AuditResult = 'success' | 'denied';
export type AuditActorKind = 'user' | 'api_key' | 'system';

/** One audit row as the store keeps it. Values of fields are not stored by design (only `attempts`). */
export interface AuditEventRow {
  readonly eventId: string;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly occurredAt: string;
  readonly actor: { readonly id: string; readonly kind: AuditActorKind };
  readonly correlationId: string;
}

/** A bounded half-open instant range `[from, to)` plus the optional narrowing filters. */
export interface AuditFilter {
  readonly from: string;
  readonly to: string;
  readonly actorId?: string;
  readonly entityType?: string;
  readonly entityId?: string;
  /** A prefix of an allowlisted action domain, such as `incident.` or `vehicle.status`. */
  readonly actionPrefix?: string;
  readonly result?: AuditResult;
}

/** Keyset position: the page continues strictly after this row in `occurredAt desc, eventId desc` order. */
export interface AuditPosition {
  readonly occurredAt: string;
  readonly eventId: string;
}

export interface AuditPageRequest {
  readonly limit: AuditPageSize;
  readonly after?: AuditPosition;
}

export interface AuditSlice {
  readonly rows: readonly AuditEventRow[];
  /** Rows matching the filter, regardless of the page. */
  readonly total: number;
  /** True when rows exist after the last one returned. */
  readonly hasMore: boolean;
}

/** Read port over the durable audit trail. A tenant is always named by the session, never by a request. */
export interface AuditEventReader {
  query(tenantId: string, filter: AuditFilter, page: AuditPageRequest): Promise<AuditSlice>;
}

/** An event written to the local audit whose relay to the durable store is not complete. */
export interface PendingAuditItem {
  readonly eventId: string;
  readonly occurredAt: string;
  readonly action: string;
  readonly entityType: string;
  readonly delivery: 'pending' | 'delivered' | 'missing';
  readonly ageSeconds: number;
}

export interface AuditReconciliation {
  readonly from: string;
  readonly to: string;
  readonly generatedAt: string;
  /** Rows of the local audit in the range. */
  readonly local: number;
  /** Of those, rows already in the durable store. */
  readonly relayed: number;
  /** Rows not yet in the durable store (oldest first, at most `PENDING_ITEM_LIMIT`). */
  readonly pending: readonly PendingAuditItem[];
  readonly pendingTotal: number;
  readonly oldestPendingAgeSeconds: number | null;
}
export const PENDING_ITEM_LIMIT = 100;

/** Compares the local audit with the durable relay for a range. It never repairs or edits a row. */
export interface AuditReconciler {
  reconcile(tenantId: string, from: string, to: string, now: Date): Promise<AuditReconciliation>;
}

/** Scalar a module history keeps without personal data or amounts. */
export type ChangeScalar = string | number | boolean | null;
export interface ChangeField {
  readonly name: string;
  readonly before?: ChangeScalar;
  readonly after?: ChangeScalar;
}
/** One change of a module history, at the instant of its audit event. */
export interface ChangeRecord {
  readonly occurredAt: string;
  readonly command: string;
  readonly fields: readonly ChangeField[];
}
export interface ChangeSource {
  changes(tenantId: string, entityId: string): Promise<readonly ChangeRecord[]>;
}

/** A readable description of a record; `pii` marks descriptions that identify a person. */
export interface EntityDescription {
  readonly label: string;
  readonly pii?: boolean;
}
export interface EntityDescriber {
  /** Absent for a record that does not exist in this company (deleted or foreign). */
  describe(tenantId: string, entityId: string): Promise<EntityDescription | null>;
}

/** What the caller may see besides the audit itself. */
export interface AuditViewer {
  readonly permissions: readonly string[];
}

export type DiffState = 'value' | 'restricted' | 'not_recorded';
export interface AuditChange {
  readonly field: string;
  readonly label: string;
  readonly state: DiffState;
  readonly before?: ChangeScalar;
  readonly after?: ChangeScalar;
}

export interface AuditEntryView {
  readonly eventId: string;
  readonly occurredAt: string;
  readonly action: string;
  readonly actionLabel: string;
  readonly result: AuditResult;
  readonly entityType: string;
  readonly entityTypeLabel: string;
  readonly entityId: string;
  /** Readable description; «registro no disponible» for a deleted or foreign record. */
  readonly entityLabel: string;
  /** False when the module has no such record in this company (deleted or never existed). */
  readonly entityAvailable: boolean;
  readonly actor: {
    readonly id: string;
    readonly kind: AuditActorKind;
    /** Role (or "Sistema"/"Integración"): the identity contract carries no names. */
    readonly label: string;
    /** Stable pseudonym of the actor inside the company. */
    readonly alias: string;
  };
  readonly correlationId: string;
  /** Changed fields; null when the record has no field history or the caller may not read its module. */
  readonly changes: readonly AuditChange[] | null;
}

export interface AuditEntryPage {
  readonly items: readonly AuditEntryView[];
  readonly total: number;
  readonly next: AuditPosition | null;
  readonly from: string;
  readonly to: string;
}
