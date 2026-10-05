export type AuditActorKind = 'user' | 'api_key' | 'system';

export interface AuditContext {
  readonly tenantId: string;
  readonly actorId: string;
  readonly actorKind: AuditActorKind;
  readonly correlationId: string;
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
const SENSITIVE_KEY =
  /(password|secret|token|authorization|cookie|credential|private.?key|access.?key|refresh.?token|ssn|tax.?id|license|phone|email|address|birth|dob|national.?id)/i;
const SECRET_VALUE = /(?:bearer\s+|sk-[A-Za-z0-9]|AKIA[A-Z0-9]{16}|-----BEGIN|[A-Fa-f0-9]{32,})/i;
const FREE_FORM_PII =
  /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\b(?:\+?\d[\d .()-]{7,}\d)\b|\b\d{3}-\d{2}-\d{4}\b/g;
function scrub(value: unknown, key = ''): unknown {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string')
    return SECRET_VALUE.test(value) ? '[REDACTED]' : value.slice(0, 2000);
  if (Array.isArray(value)) return value.map((item) => scrub(item, key));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, scrub(item, name)]),
    );
  return value;
}
export function redactAuditData(
  data: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return scrub(data) as Readonly<Record<string, unknown>>;
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
): AuditEvent {
  if (!context.tenantId.trim()) throw new Error('tenant is required');
  return {
    ...input,
    tenantId: context.tenantId,
    actor: { id: context.actorId, kind: context.actorKind },
    correlationId: context.correlationId,
    data: redactAuditData(input.data ?? {}),
  };
}
export interface AuditStore {
  append(event: AuditEvent): void;
  list(tenantId: string): readonly AuditEvent[];
}
export class InMemoryAuditStore implements AuditStore {
  private readonly events: AuditEvent[] = [];
  append(event: AuditEvent): void {
    if (!this.events.some((existing) => existing.eventId === event.eventId))
      this.events.push(structuredClone(event));
  }
  list(tenantId: string): readonly AuditEvent[] {
    return this.events
      .filter((event) => event.tenantId === tenantId)
      .map((event) => structuredClone(event));
  }
}
