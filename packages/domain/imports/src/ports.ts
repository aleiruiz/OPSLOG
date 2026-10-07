import type { ImportEntity, ImportJob, RowIssue } from './types.js';

/** What creating one row through the entity service produced: the new id, or why the row was refused. */
export type CreateOutcome = { readonly id: string } | { readonly issue: RowIssue };

/**
 * Port to the module of one entity (vehicles or employees). The composition implements it over the
 * existing services, so every rule of those modules (unique keys per tenant, active area, sealing
 * of personal data) applies exactly as on their own create. Failures that are not a verdict about
 * the row (a store outage) are thrown, never turned into an issue.
 */
export interface ImportTarget {
  /** Columns whose value the entity service would refuse (empty when the row is valid). */
  invalidColumns(input: Readonly<Record<string, unknown>>, now: Date): readonly string[];
  /** Normalized natural keys `[column, key]` of a valid row, to find repeats inside the request. */
  keys(input: Readonly<Record<string, unknown>>): readonly (readonly [string, string])[];
  /** Read-only checks against stored data (existing keys, active area); aligned with `inputs`. */
  precheck(
    tenantId: string,
    inputs: readonly Readonly<Record<string, unknown>>[],
  ): Promise<readonly (RowIssue | null)[]>;
  /** Creates the row through the entity service. */
  create(
    tenantId: string,
    actorId: string,
    input: Readonly<Record<string, unknown>>,
  ): Promise<CreateOutcome>;
}

/** Told about every vehicle or employee a job creates, as it is created (the composition audits it). */
export interface ImportObserver {
  created(entity: ImportEntity, id: string): void;
}

/** How long a `running` job counts as being executed by someone: a retry inside it is a `conflict`, after it the job is resumed. */
export const DEFAULT_LEASE_MS = 120_000;

export interface ImportServiceOptions {
  readonly targets: Readonly<Record<ImportEntity, ImportTarget>>;
  readonly leaseMs?: number;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

export interface Submitted {
  readonly job: ImportJob;
  /** True when the idempotency key already belonged to a finished job: nothing was run again. */
  readonly replayed: boolean;
}

export interface ImportListQuery {
  readonly entity?: unknown;
  readonly status?: unknown;
  readonly limit?: unknown;
  readonly offset?: unknown;
}
export interface ImportRowsQuery {
  readonly outcome?: unknown;
  readonly limit?: unknown;
  readonly offset?: unknown;
}
export interface ImportHistoryQuery {
  readonly limit?: unknown;
  readonly offset?: unknown;
}
