export type AuditActorKind = 'user' | 'api_key' | 'system';

export interface AuditContext {
  readonly tenantId: string;
  readonly actorId: string;
  readonly actorKind: AuditActorKind;
  readonly correlationId: string;
}
export interface AuditData {
  readonly attempts?: number;
}
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
const SENSITIVE_KEY =
  /(password|secret|token|authorization|cookie|credential|private.?key|access.?key|refresh.?token|ssn|tax.?id|rfc|curp|license|phone|email|address|birth|dob|national.?id)/i;
const SECRET_VALUE = /(?:bearer\s+|sk-[A-Za-z0-9]|AKIA[A-Z0-9]{16}|-----BEGIN|[A-Fa-f0-9]{32,})/i;
const FREE_FORM_PII =
  /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\b(?:\+?\d[\d .()-]{7,}\d)\b|\b\d{3}-\d{2}-\d{4}\b/g;
const USER_ACTOR_ID = /^user-[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const API_ACTOR_ID = /^api-[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const SYSTEM_ACTOR_ID = /^worker-[a-z0-9_-]{1,64}$/i;
const REDACTED = '[REDACTED]';
function scrub(value: unknown, key = ''): unknown {
  if (SENSITIVE_KEY.test(key)) return REDACTED;
  if (typeof value === 'string') {
    if (SECRET_VALUE.test(value)) return REDACTED;
    return value.replace(FREE_FORM_PII, REDACTED).slice(0, 2000);
  }
  if (Array.isArray(value)) return value.map((item) => scrub(item, key));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, scrub(item, name)]),
    );
  return value;
}
export function redactAuditData(data: Readonly<Record<string, unknown>>): AuditData {
  const safeData: { attempts?: number } = {};
  if (Number.isSafeInteger(data.attempts) && Number(data.attempts) >= 0) {
    safeData.attempts = data.attempts;
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
export function redactError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'handler failed';
  return String(scrub(message, 'error')).replace(FREE_FORM_PII, '[REDACTED]').slice(0, 500);
}
export function createAuditEvent(
  context: AuditContext,
  input: Omit<AuditEvent, 'tenantId' | 'actor' | 'correlationId' | 'data'> & {
    data?: Readonly<Record<string, unknown>>;
  },
): PersistedAuditEvent {
  if (!context.tenantId.trim()) throw new Error('tenant is required');
  return {
    ...input,
    tenantId: context.tenantId,
    actor: { id: sanitizeActorId(context.actorId, context.actorKind), kind: context.actorKind },
    correlationId: context.correlationId,
    data: redactAuditData(input.data ?? {}),
  };
}
export interface AuditStore {
  /** Implementations must sanitize actor references and allowlist data before persistence. */
  append(event: AuditEvent): void;
  list(tenantId: string): readonly PersistedAuditEvent[];
}
export class InMemoryAuditStore implements AuditStore {
  private readonly events = new Map<string, PersistedAuditEvent>();
  append(event: AuditEvent): void {
    const safeEvent = structuredClone(event);
    const key = scopedKey(safeEvent.tenantId, safeEvent.eventId);
    if (!this.events.has(key)) {
      this.events.set(key, {
        ...safeEvent,
        actor: {
          ...safeEvent.actor,
          id: sanitizeActorId(safeEvent.actor.id, safeEvent.actor.kind),
        },
        data: redactAuditData(safeEvent.data),
      });
    }
  }
  list(tenantId: string): readonly PersistedAuditEvent[] {
    return [...this.events.values()]
      .filter((event) => event.tenantId === tenantId)
      .map((event) => structuredClone(event));
  }
}
function scopedKey(tenantId: string, eventId: string): string {
  return `${tenantId.length}:${tenantId}${eventId.length}:${eventId}`;
}
