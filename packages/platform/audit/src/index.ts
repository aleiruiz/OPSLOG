export type AuditActorKind = 'user' | 'api_key' | 'system';

export interface AuditContext {
  readonly tenantId: string;
  readonly actorId: string;
  readonly actorKind: AuditActorKind;
  readonly correlationId: string;
}
export type AuditData = { readonly attempts?: number };
export interface AuditEvent {
  readonly eventId: string;
  readonly tenantId: string;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly occurredAt: string;
  readonly actor: { readonly id: string; readonly kind: AuditActorKind };
  readonly correlationId: string;
  readonly data: Readonly<Record<string, unknown>>;
}
export interface PersistedAuditEvent extends Omit<AuditEvent, 'data'> {
  readonly data: AuditData;
}
const SECRET_VALUE = /(?:bearer\s+|sk-[A-Za-z0-9]|AKIA[A-Z0-9]{16}|-----BEGIN|[A-Fa-f0-9]{32,})/i;
const FREE_FORM_PII =
  /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\b(?:\+?\d[\d .()-]{7,}\d)\b|\b\d{3}-\d{2}-\d{4}\b/g;
const USER_ACTOR_ID = /^user-[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const API_ACTOR_ID = /^api-[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const SYSTEM_ACTOR_ID = /^worker-[a-z0-9_-]{1,64}$/i;
const REDACTED = '[REDACTED]';
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const LABEL = /^[a-z][a-z0-9_.:-]{0,63}$/i;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const opaque = (value: unknown): string =>
  typeof value === 'string' && OPAQUE_ID.test(value) ? value : REDACTED;
const label = (value: unknown): string =>
  typeof value === 'string' && LABEL.test(value) ? value : REDACTED;
const ACTOR_KINDS: readonly AuditActorKind[] = ['user', 'api_key', 'system'];
/** Keys that identify and deduplicate a record cannot be redacted: they are rejected instead. */
function requireKey(value: unknown, field: string): string {
  if (typeof value !== 'string' || !OPAQUE_ID.test(value))
    throw new Error(`invalid audit ${field}`);
  return value;
}
const instant = (value: unknown): string =>
  typeof value === 'string' && ISO_INSTANT.test(value) ? value : REDACTED;
/** Builds the persisted shape field by field; unknown runtime fields and free-form identifiers never survive. */
export function sanitizeAuditEvent(event: AuditEvent): PersistedAuditEvent {
  if (!ACTOR_KINDS.includes(event.actor.kind)) throw new Error('invalid audit actor kind');
  return {
    eventId: requireKey(event.eventId, 'eventId'),
    tenantId: requireKey(event.tenantId, 'tenantId'),
    action: label(event.action),
    entityType: label(event.entityType),
    entityId: opaque(event.entityId),
    occurredAt: instant(event.occurredAt),
    actor: {
      id: sanitizeActorId(event.actor.id, event.actor.kind),
      kind: event.actor.kind,
    },
    correlationId: opaque(event.correlationId),
    data: redactAuditData(event.data ?? {}),
  };
}
function scrub(value: string): string {
  if (SECRET_VALUE.test(value)) return REDACTED;
  return value.replace(FREE_FORM_PII, REDACTED).slice(0, 2000);
}
export function redactAuditData(data: Readonly<Record<string, unknown>>): AuditData {
  const safeData: { attempts?: number } = {};
  const attempts = data.attempts;
  if (typeof attempts === 'number' && Number.isSafeInteger(attempts) && attempts >= 0) {
    safeData.attempts = attempts;
  }
  return safeData;
}
function sanitizeActorId(actorId: string, actorKind: AuditActorKind): string {
  const isOpaque =
    (actorKind === 'user' && USER_ACTOR_ID.test(actorId)) ||
    (actorKind === 'api_key' && API_ACTOR_ID.test(actorId)) ||
    (actorKind === 'system' && (actorId === 'system' || SYSTEM_ACTOR_ID.test(actorId)));
  return isOpaque ? actorId : REDACTED;
}
const CREDENTIAL_PAIR =
  /(?<![A-Za-z0-9])[\w-]{0,32}(?:password|passwd|secret|token|api[_-]?key|authorization|cookie|credential)s?["']?\s*[=:]\s*(?:"[^"]*(?:"|$)|'[^']*(?:'|$)|(?:(?:bearer|basic|digest|token)\s+)?\S+)/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]+){0,2}/g;
/** Only the message is kept, with credential-like and PII-like text removed; names in free text cannot be detected. */
export function redactError(error: unknown): string {
  // Cap before scanning so a huge upstream message cannot stall the event loop.
  const message = (error instanceof Error ? error.message : 'handler failed').slice(0, 2000);
  return scrub(message.replace(CREDENTIAL_PAIR, REDACTED).replace(JWT, REDACTED)).slice(0, 500);
}
export function createAuditEvent(
  context: AuditContext,
  input: Omit<AuditEvent, 'tenantId' | 'actor' | 'correlationId' | 'data'> & {
    data?: Readonly<Record<string, unknown>>;
  },
): PersistedAuditEvent {
  if (!context.tenantId.trim()) throw new Error('tenant is required');
  return sanitizeAuditEvent({
    ...input,
    tenantId: context.tenantId,
    actor: { id: context.actorId, kind: context.actorKind },
    correlationId: context.correlationId,
    data: input.data ?? {},
  });
}
export interface AuditStore {
  /** Implementations must sanitize actor references and allowlist data before persistence. */
  append(event: AuditEvent): Promise<void>;
  list(tenantId: string, range?: AuditListRange): Promise<readonly PersistedAuditEvent[]>;
}

/** A bounded half-open time range keeps every tenant audit read indexable and finite. */
export interface AuditListRange {
  readonly from: string;
  readonly to: string;
  readonly limit?: number;
}

export function defaultAuditListRange(now = new Date()): Required<AuditListRange> {
  return {
    from: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    to: new Date(now.getTime() + 1).toISOString(),
    limit: 500,
  };
}

export function validateAuditListRange(range?: AuditListRange): Required<AuditListRange> {
  range ??= defaultAuditListRange();
  const from = Date.parse(range.from);
  const to = Date.parse(range.to);
  const limit = range.limit ?? 500;
  if (
    !Number.isFinite(from) ||
    !Number.isFinite(to) ||
    from >= to ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 1000
  )
    throw new Error('invalid audit time range');
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString(), limit };
}

export class AuditConflictError extends Error {
  readonly code = 'AUDIT_EVENT_CONFLICT';
  constructor() {
    super('Audit event id was already used with different content');
    this.name = 'AuditConflictError';
  }
}

export class InMemoryAuditStore implements AuditStore {
  private readonly events = new Map<string, PersistedAuditEvent>();
  async append(event: AuditEvent): Promise<void> {
    const safeEvent = sanitizeAuditEvent(structuredClone(event));
    const key = scopedKey(safeEvent.tenantId, safeEvent.eventId);
    const prior = this.events.get(key);
    if (prior && canonicalAuditEvent(prior) !== canonicalAuditEvent(safeEvent))
      throw new AuditConflictError();
    if (!prior) this.events.set(key, safeEvent);
  }
  async list(tenantId: string, range?: AuditListRange): Promise<readonly PersistedAuditEvent[]> {
    const bounded = validateAuditListRange(range);
    const from = Date.parse(bounded.from);
    const to = Date.parse(bounded.to);
    return [...this.events.values()]
      .filter((event) => {
        const occurredAt = Date.parse(event.occurredAt);
        return event.tenantId === tenantId && occurredAt >= from && occurredAt < to;
      })
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
      .slice(0, bounded.limit)
      .map((event) => structuredClone(event));
  }

  /** Synchronous inspection for tests that assert on in-memory adapter state. */
  snapshotForTesting(tenantId: string): readonly PersistedAuditEvent[] {
    return [...this.events.values()]
      .filter((event) => event.tenantId === tenantId)
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
      .map((event) => structuredClone(event));
  }
}
function canonicalAuditEvent(event: PersistedAuditEvent): string {
  const occurredAt = Date.parse(event.occurredAt);
  return JSON.stringify({
    ...event,
    occurredAt: Number.isFinite(occurredAt) ? new Date(occurredAt).toISOString() : event.occurredAt,
  });
}
function scopedKey(tenantId: string, eventId: string): string {
  return `${tenantId.length}:${tenantId}${eventId.length}:${eventId}`;
}
