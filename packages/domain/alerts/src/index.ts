import {
  MAX_LIST_LIMIT,
  DEFAULT_LIST_LIMIT,
  MIN_DATE,
  addDays,
  dateOf,
  expiryOf,
  requireOpaqueId,
  type ExpiryFilter,
} from '../../documents/src/index.js';

/**
 * Base expiry alerts (FLT-ALERTS, first slice: BRD §15.1, FR-091, FR-132, FR-150, BR-007). An alert
 * is a vehicle document or an insurance policy that is `expiring` (from `windowDays` before its
 * last valid day, inclusive, until that day) or `expired` (after it). Alerts are DERIVED on every
 * read from the documents and policies stores, as of the UTC date of the service clock and with the
 * company's window setting: nothing is stored, queued or sent. The durable outbox, e-mail and
 * per-threshold deduplication are deferred; `key` already carries what that dedupe needs (source,
 * subject and the expiry date, so a renewal starts a new cycle, FR-151).
 */
export { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT };

export const ALERT_SOURCES = ['vehicle_document', 'insurance_policy'] as const;
export type AlertSourceKind = (typeof ALERT_SOURCES)[number];
export const isAlertSource = (value: unknown): value is AlertSourceKind =>
  typeof value === 'string' && (ALERT_SOURCES as readonly string[]).includes(value);

export const ALERT_SEVERITIES = ['expiring', 'expired'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];
export const isAlertSeverity = (value: unknown): value is AlertSeverity =>
  typeof value === 'string' && (ALERT_SEVERITIES as readonly string[]).includes(value);

/** Deep pages re-read both sources from the start: the offset is bounded (a stored alert table lifts it). */
export const MAX_ALERT_OFFSET = 2_000;

export type AlertErrorCode = 'invalid_input';

export class AlertError extends Error {
  public constructor(public readonly code: AlertErrorCode) {
    super(`Alert request rejected: ${code}`);
    this.name = 'AlertError';
  }
}

export interface Alert {
  /** Dedupe key: source, subject and expiry date. A renewal changes the date, so it starts a new cycle. */
  readonly key: string;
  readonly source: AlertSourceKind;
  /** Id of the document or of the policy. */
  readonly subjectId: string;
  readonly vehicleId: string;
  /** Document type code, or the coverage type of the policy. */
  readonly typeCode: string;
  /** `YYYY-MM-DD`: the last valid day, inclusive. */
  readonly dueOn: string;
  /** Whole days from the as-of date to `dueOn` (0 on the last valid day, negative once expired). */
  readonly daysToExpiry: number;
  readonly severity: AlertSeverity;
}

const invalid = (): never => {
  throw new AlertError('invalid_input');
};

const guardId = (value: unknown): string => {
  try {
    return requireOpaqueId(value);
  } catch {
    return invalid();
  }
};

const isInteger = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

// ---- ports ------------------------------------------------------------------------------------

/** A document or policy that is due, as the sources report it (never a person, never a title). */
export interface AlertCandidate {
  readonly subjectId: string;
  readonly vehicleId: string;
  readonly typeCode: string;
  readonly dueOn: string;
}

export interface AlertScope {
  readonly vehicleId?: string;
  /** Range of expiry keys to read (see `ExpiryFilter`). */
  readonly expiry: ExpiryFilter;
}

export interface AlertWindow {
  readonly limit: number;
  readonly offset: number;
}

export interface AlertCandidateSlice {
  readonly items: readonly AlertCandidate[];
  /** Number of candidates in scope, not only the window. */
  readonly total: number;
}

/**
 * One source of due items. Tenant-scoped; excludes archived documents and policies; ordered by
 * expiry date and then subject id (code-unit order), so sources can be merged.
 */
export interface AlertSource {
  due(tenantId: string, scope: AlertScope, window: AlertWindow): Promise<AlertCandidateSlice>;
}

/** The company's expiry window, in days. */
export interface AlertWindowReader {
  expiryWindowDays(tenantId: string): Promise<number>;
}

export interface AlertListQuery {
  readonly source?: unknown;
  readonly severity?: unknown;
  readonly vehicleId?: unknown;
  readonly limit?: unknown;
  readonly offset?: unknown;
}

export interface AlertSlice {
  readonly items: readonly Alert[];
  readonly total: number;
  /** UTC date the alerts were derived for. */
  readonly asOf: string;
  readonly windowDays: number;
}

export interface AlertServiceOptions {
  readonly now?: () => Date;
}

const compareKeys = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const compareAlerts = (a: Alert, b: Alert): number =>
  compareKeys(a.dueOn, b.dueOn) ||
  compareKeys(a.source, b.source) ||
  compareKeys(a.subjectId, b.subjectId);

/** The expiry range of a severity filter as of `today`: `expired` before it, `expiring` from it to the end of the window, both from the earliest date. */
export function scopeOf(
  severity: AlertSeverity | undefined,
  today: string,
  windowDays: number,
): ExpiryFilter {
  const until = addDays(today, windowDays);
  if (severity === 'expired') return { status: 'expired', from: today, until };
  return { status: 'expiring', from: severity === 'expiring' ? today : MIN_DATE, until };
}

/** Derives the alert of a candidate as of `today`; never an alert for something not yet in the window. */
export function alertOf(
  source: AlertSourceKind,
  candidate: AlertCandidate,
  today: string,
  windowDays: number,
): Alert | null {
  const daysToExpiry = expiryOf(candidate.dueOn, today).daysToExpiry as number;
  if (daysToExpiry > windowDays) return null;
  return {
    key: `${source}:${candidate.subjectId}:${candidate.dueOn}`,
    source,
    subjectId: candidate.subjectId,
    vehicleId: candidate.vehicleId,
    typeCode: candidate.typeCode,
    dueOn: candidate.dueOn,
    daysToExpiry,
    severity: daysToExpiry < 0 ? 'expired' : 'expiring',
  };
}

/**
 * Alert use cases over the sources. Authorization and authentication belong to the caller (the
 * composition); the tenant is always an argument taken from the server-side session. The service
 * only reads: it never writes, enqueues or notifies.
 */
export class AlertService {
  private readonly now: () => Date;

  public constructor(
    private readonly sources: Readonly<Record<AlertSourceKind, AlertSource>>,
    private readonly settings: AlertWindowReader,
    options: AlertServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  /** The first `count` due items of one source, read in pages of at most `MAX_LIST_LIMIT`. */
  private async head(
    kind: AlertSourceKind,
    tenantId: string,
    scope: AlertScope,
    count: number,
    today: string,
    windowDays: number,
  ): Promise<{ readonly alerts: Alert[]; readonly total: number }> {
    const alerts: Alert[] = [];
    let total = 0;
    for (let offset = 0; ; offset += MAX_LIST_LIMIT) {
      const slice = await this.sources[kind].due(tenantId, scope, {
        limit: MAX_LIST_LIMIT,
        offset,
      });
      total = slice.total;
      for (const candidate of slice.items) {
        const alert = alertOf(kind, candidate, today, windowDays);
        if (alert) alerts.push(alert);
      }
      if (alerts.length >= count || offset + MAX_LIST_LIMIT >= total) return { alerts, total };
    }
  }

  /** Expiring and expired alerts of the tenant, soonest due date first, then source and subject id. */
  public async list(tenantId: string, query: AlertListQuery = {}): Promise<AlertSlice> {
    guardId(tenantId);
    const limit = query.limit === undefined ? DEFAULT_LIST_LIMIT : query.limit;
    const offset = query.offset === undefined ? 0 : query.offset;
    if (!isInteger(limit, 1, MAX_LIST_LIMIT) || !isInteger(offset, 0, MAX_ALERT_OFFSET))
      return invalid();
    if (query.source !== undefined && !isAlertSource(query.source)) return invalid();
    if (query.severity !== undefined && !isAlertSeverity(query.severity)) return invalid();
    const vehicleId = query.vehicleId === undefined ? undefined : guardId(query.vehicleId);
    const today = dateOf(this.now());
    const windowDays = await this.settings.expiryWindowDays(tenantId);
    const expiry = scopeOf(query.severity, today, windowDays);
    const scope: AlertScope = { expiry, ...(vehicleId === undefined ? {} : { vehicleId }) };
    const kinds = query.source === undefined ? ALERT_SOURCES : [query.source];
    const heads = await Promise.all(
      kinds.map((kind) => this.head(kind, tenantId, scope, offset + limit, today, windowDays)),
    );
    const merged = heads.flatMap((head) => head.alerts).sort(compareAlerts);
    return {
      items: merged.slice(offset, offset + limit),
      total: heads.reduce((sum, head) => sum + head.total, 0),
      asOf: today,
      windowDays,
    };
  }
}
