import { isAllowedActionPrefix } from './catalog.js';
import { AUDIT_ENTITY_TYPES } from './entities.js';
import { AuditQueryError } from './errors.js';
import {
  AUDIT_DEFAULT_RANGE_DAYS,
  AUDIT_MAX_RANGE_DAYS,
  AUDIT_PAGE_SIZES,
  type AuditFilter,
  type AuditPageRequest,
  type AuditPageSize,
  type AuditPosition,
  type AuditResult,
} from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/** What a caller may ask for. Every field is validated again here: the HTTP layer is not trusted to have done it. */
export interface AuditQueryInput {
  readonly from?: string;
  readonly to?: string;
  readonly actorId?: string;
  readonly entityType?: string;
  readonly entityId?: string;
  readonly action?: string;
  readonly result?: string;
  readonly limit?: number;
  readonly after?: AuditPosition;
}

const invalid = (): never => {
  throw new AuditQueryError('invalid_input');
};

function instant(value: string): number {
  if (!INSTANT.test(value)) return invalid();
  const time = Date.parse(value);
  // `Date.parse` rolls an impossible day (February 30th) over to the next month: compare the calendar date.
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value.slice(0, 10)
    ? time
    : invalid();
}

function opaque(value: string): string {
  return OPAQUE_ID.test(value) ? value : invalid();
}

/**
 * Turns a request into the bounded filter and page the reader runs. Without a range the last 30 days
 * are listed; a range needs both ends, `from < to` and at most 366 days.
 */
export function resolveAuditQuery(
  input: AuditQueryInput,
  now: Date,
): { readonly filter: AuditFilter; readonly page: AuditPageRequest } {
  let from: number;
  let to: number;
  if (input.from === undefined && input.to === undefined) {
    to = now.getTime() + 1;
    from = to - AUDIT_DEFAULT_RANGE_DAYS * DAY_MS;
  } else if (input.from !== undefined && input.to !== undefined) {
    from = instant(input.from);
    to = instant(input.to);
    if (from >= to || to - from > AUDIT_MAX_RANGE_DAYS * DAY_MS) invalid();
  } else return invalid();
  const limit = input.limit ?? 25;
  if (!(AUDIT_PAGE_SIZES as readonly number[]).includes(limit)) invalid();
  if (input.entityType !== undefined && !AUDIT_ENTITY_TYPES.includes(input.entityType)) invalid();
  if (input.action !== undefined && !isAllowedActionPrefix(input.action)) invalid();
  if (input.result !== undefined && input.result !== 'success' && input.result !== 'denied')
    invalid();
  if (input.after !== undefined) {
    instant(input.after.occurredAt);
    opaque(input.after.eventId);
  }
  const filter: AuditFilter = {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    ...(input.actorId === undefined ? {} : { actorId: opaque(input.actorId) }),
    ...(input.entityType === undefined ? {} : { entityType: input.entityType }),
    ...(input.entityId === undefined ? {} : { entityId: opaque(input.entityId) }),
    ...(input.action === undefined ? {} : { actionPrefix: input.action }),
    ...(input.result === undefined ? {} : { result: input.result as AuditResult }),
  };
  return {
    filter,
    page: { limit: limit as AuditPageSize, ...(input.after ? { after: input.after } : {}) },
  };
}
