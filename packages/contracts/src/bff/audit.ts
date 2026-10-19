import type { ISODateTime, Page } from '../index.js';
import type { BffRouteDefinition } from './shared.js';

export const BFF_AUDIT_RESULTS = ['success', 'denied'] as const;
export type BffAuditResult = (typeof BFF_AUDIT_RESULTS)[number];
export type BffAuditActorKind = 'user' | 'api_key' | 'system';

/**
 * How one changed field is shown (ADR-0016, question 1): `value` carries what the module history kept;
 * `restricted` is a field with personal data, amounts or free text whose value never travels; `not_recorded`
 * is a field whose value the history does not keep (only the fact that it changed).
 */
export const BFF_AUDIT_CHANGE_STATES = ['value', 'restricted', 'not_recorded'] as const;
export type BffAuditChangeState = (typeof BFF_AUDIT_CHANGE_STATES)[number];

export interface BffAuditChange {
  readonly field: string;
  /** Spanish name of the field. */
  readonly label: string;
  readonly state: BffAuditChangeState;
  /** Only with `state: 'value'`; codes of the module (the screen translates them). */
  readonly before?: string | number | boolean | null;
  readonly after?: string | number | boolean | null;
}

/**
 * One audited event, as the caller may read it. The company is implicit. The actor is a role (or
 * «Sistema»/«Integración») plus a stable alias: the identity contract carries no names.
 */
export interface BffAuditEntry {
  readonly eventId: string;
  readonly occurredAt: ISODateTime;
  /** Catalog code of the action, for filtering. */
  readonly action: string;
  readonly actionLabel: string;
  readonly result: BffAuditResult;
  readonly entityType: string;
  readonly entityTypeLabel: string;
  readonly entityId: string;
  /** Readable description of the record, or «Registro no disponible» when it was deleted or does not exist. */
  readonly entityLabel: string;
  readonly entityAvailable: boolean;
  readonly actor: {
    readonly id: string;
    readonly kind: BffAuditActorKind;
    readonly label: string;
    readonly alias: string;
  };
  readonly correlationId: string;
  /** Changed fields of the records that keep a field history (incidents, work orders); null otherwise. */
  readonly changes: readonly BffAuditChange[] | null;
}

/**
 * Filters of the global listing. `from` and `to` (UTC instants, `from < to`, at most 366 days) come together;
 * without them the last 30 days are listed. `action` is an allowlisted prefix such as `incident.`.
 */
export interface BffAuditQuery {
  readonly from?: ISODateTime;
  readonly to?: ISODateTime;
  readonly actorId?: string;
  readonly entityType?: string;
  readonly entityId?: string;
  readonly action?: string;
  readonly result?: BffAuditResult;
  readonly limit?: 25 | 50 | 100;
  readonly cursor?: string;
}
export type BffAuditEntityQuery = Omit<BffAuditQuery, 'actorId' | 'entityType' | 'entityId'>;

/** Newest first; `total` counts the whole filter. `from`/`to` echo the range that was applied. */
export interface BffAuditPage extends Page<BffAuditEntry> {
  readonly from: ISODateTime;
  readonly to: ISODateTime;
}

export interface BffAuditPendingEvent {
  readonly eventId: string;
  readonly occurredAt: ISODateTime;
  readonly action: string;
  readonly entityType: string;
  /** `missing`: the event has no delivery row at all. */
  readonly delivery: 'pending' | 'delivered' | 'missing';
  readonly ageSeconds: number;
}

/** Local audit against the durable store for a range (FR-170). Read-only: nothing is repaired. */
export interface BffAuditReconciliation {
  readonly from: ISODateTime;
  readonly to: ISODateTime;
  readonly generatedAt: ISODateTime;
  readonly local: number;
  readonly relayed: number;
  readonly pendingTotal: number;
  readonly oldestPendingAgeSeconds: number | null;
  /** Oldest first, at most 100. */
  readonly pending: readonly BffAuditPendingEvent[];
}

export interface BffAuditReconciliationQuery {
  readonly from?: ISODateTime;
  readonly to?: ISODateTime;
}

/** Request and response types of the audit routes. All need `view_audit`; the entity route also the module's read permission. */
export interface AuditRouteTypes {
  'audit.list': { query?: BffAuditQuery; response: BffAuditPage };
  'audit.reconciliation': {
    query?: BffAuditReconciliationQuery;
    response: BffAuditReconciliation;
  };
  'audit.entity': {
    params: { entityType: string; entityId: string };
    query?: BffAuditEntityQuery;
    response: BffAuditPage;
  };
}

const audit = ['api', 'v1', 'audit'] as const;
export const AUDIT_ROUTES = {
  'audit.list': { method: 'GET', path: audit, kind: 'session', status: 200 },
  // Declared before the entity route: the literal segment is never read as an entity type.
  'audit.reconciliation': {
    method: 'GET',
    path: [...audit, 'reconciliation'],
    kind: 'session',
    status: 200,
  },
  'audit.entity': {
    method: 'GET',
    path: [...audit, 'entities', ':entityType', ':entityId'],
    kind: 'session',
    status: 200,
  },
} as const satisfies Record<keyof AuditRouteTypes, BffRouteDefinition>;
