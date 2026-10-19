import { createHash } from 'node:crypto';
import { OPS_STAT_KEYS } from './stats.js';

export type LogLevel = 'info' | 'warn' | 'error';

/**
 * What a log call may carry. Every field is checked against its own shape before it is written, and
 * anything else is dropped: a caller cannot log free text, a request value, a token or a stack by
 * passing it in (SPECS §9.3, NFR-M1). `msg` is an event code, never a sentence.
 */
export interface LogFields {
  /** Opaque company reference (see `opaqueRef`), never the company id or name. */
  readonly companyRef?: string | undefined;
  readonly correlationId?: string | undefined;
  /** Opaque actor reference (see `opaqueRef`), never a subject, e-mail or name. */
  readonly actorRef?: string | undefined;
  /** Static route id such as `GET /api/vehicles/:id`: no query string, no identifier values. */
  readonly route?: string | undefined;
  readonly durationMs?: number | undefined;
  readonly status?: number | undefined;
  readonly errorClass?: string | undefined;
  readonly job?: string | undefined;
  readonly count?: number | undefined;
  /** TCP port the API listens on. */
  readonly port?: number | undefined;
  readonly mode?: string | undefined;
  /** Counters of an `ops_stats` line; see `OPS_STAT_KEYS`. */
  readonly stats?: Readonly<Record<string, number>> | undefined;
}

export interface Logger {
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** A logger that always adds the given fields (such as `companyRef`) to its lines. */
  child(fields: LogFields): Logger;
}

const MSG = /^[a-z][a-z0-9_]{0,63}$/;
const OPAQUE = /^[a-z]_[0-9a-f]{16}$/;
// The BFF mints UUIDs; background work uses an opaque `w_` reference. Free-form ids are not accepted.
const CORRELATION =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|w_[0-9a-f]{16})$/i;
// `GET /api/vehicles/:id` (from `routeOf`) or a static BFF route id such as `incidents.insurance.update`.
const ROUTE = /^(?:[A-Z]{3,7} \/[A-Za-z0-9_:/.-]{0,120}|[a-z][a-z0-9]*(?:[.-][a-z0-9]+){0,5})$/;
// Job names and modes are lower-case codes; error classes are CamelCase class names (`TypeError`).
const JOB = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const MODE = /^[a-z][a-z_-]{0,31}$/;
const ERROR_CLASS = /^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*){0,5}$/;
const STAT_KEYS: ReadonlySet<string> = new Set(OPS_STAT_KEYS);

/** A stable, non-reversible reference: `c_` plus 16 hex of the SHA-256 of the value. */
export function opaqueRef(kind: 'c' | 'a', value: string): string {
  return `${kind}_${createHash('sha256').update(`opslog-ref:${kind}:${value}`).digest('hex').slice(0, 16)}`;
}

/** `GET /api/employees/abc-1?x=1` becomes `GET /api/employees/:id`: only plain lower-case words stay. */
export function routeOf(method: string, url: string): string {
  const path = url.split('?', 1)[0] ?? '';
  const segments = path
    .split('/')
    .slice(1)
    .filter((segment) => segment !== '')
    .map((segment) => (/^[a-z]{1,24}(?:-[a-z]{1,24}){0,3}$/.test(segment) ? segment : ':id'));
  const verb = /^[A-Za-z]{3,7}$/.test(method) ? method.toUpperCase() : 'OTHER';
  return `${verb} /${segments.slice(0, 8).join('/')}`.slice(0, 120);
}

const whole = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;

/** Keeps only the fields that pass their own check, in a fixed order. */
export function sanitizeFields(fields: LogFields): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const put = (key: string, value: unknown): void => {
    if (value !== undefined) out[key] = value;
  };
  const text = (value: unknown, pattern: RegExp): string | undefined =>
    typeof value === 'string' && pattern.test(value) ? value : undefined;
  put('companyRef', text(fields.companyRef, OPAQUE));
  put('correlationId', text(fields.correlationId, CORRELATION));
  put('actorRef', text(fields.actorRef, OPAQUE));
  put('route', text(fields.route, ROUTE));
  put('durationMs', whole(fields.durationMs));
  put('status', whole(fields.status));
  put('errorClass', text(fields.errorClass, ERROR_CLASS));
  put('job', text(fields.job, JOB));
  put('count', whole(fields.count));
  put('port', whole(fields.port));
  put('mode', text(fields.mode, MODE));
  if (fields.stats) {
    const stats: Record<string, number> = {};
    for (const [key, raw] of Object.entries(fields.stats)) {
      const value = whole(raw);
      if (STAT_KEYS.has(key) && value !== undefined) stats[key] = value;
    }
    put('stats', stats);
  }
  return out;
}

/**
 * One JSON object per line with `ts`, `level`, `msg` and the allowlisted fields. A `msg` that is
 * not an event code is replaced by `invalid_log_event`, so a mistaken call can never write text.
 */
export function createLogger(
  write: (line: string) => void,
  base: LogFields = {},
  now: () => Date = () => new Date(),
): Logger {
  const emit = (level: LogLevel, msg: string, fields: LogFields | undefined): void => {
    const event = {
      ts: now().toISOString(),
      level,
      msg: MSG.test(msg) ? msg : 'invalid_log_event',
      ...sanitizeFields({ ...base, ...fields }),
    };
    write(JSON.stringify(event));
  };
  return {
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    child: (fields) => createLogger(write, { ...base, ...fields }, now),
  };
}
