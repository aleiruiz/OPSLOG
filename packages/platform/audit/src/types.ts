export type AuditScalar = string | number | boolean | null;

export type AuditMetadata = Readonly<Record<string, AuditScalar>>;

export interface TenantContext {
  readonly tenantId: string;
  readonly actorRef: string;
  readonly correlationId: string;
  readonly authorizationVersion: number;
}

export interface AuditEventInput {
  readonly eventId: string;
  readonly tenantId: string;
  readonly entityId: string;
  readonly action: string;
  readonly occurredAt: Date;
  readonly actorRef: string;
  readonly correlationId: string;
  readonly metadata?: AuditMetadata;
}

export interface AuditEvent extends AuditEventInput {
  readonly schemaVersion: 1;
  readonly metadata: AuditMetadata;
}

export interface OutboxEventInput {
  readonly eventId: string;
  readonly tenantId: string;
  readonly type: string;
  readonly entityId: string;
  readonly occurredAt: Date;
  readonly actorRef: string;
  readonly correlationId: string;
  readonly payload: Readonly<Record<string, AuditScalar>>;
}

export interface OutboxEvent extends OutboxEventInput {
  readonly schemaVersion: 1;
  readonly status: 'pending' | 'published' | 'dead-lettered';
  readonly attempts: number;
  readonly nextAttemptAt?: Date;
}

export interface AuditOutboxTransaction {
  appendAudit(event: AuditEvent): Promise<void>;
  enqueue(event: OutboxEvent): Promise<void>;
}

export interface AuditOutboxStore {
  transaction<T>(work: (tx: AuditOutboxTransaction) => Promise<T>): Promise<T>;
  claimPending(limit: number, now: Date): Promise<readonly OutboxEvent[]>;
  markPublished(eventId: string): Promise<void>;
  markRetry(eventId: string, nextAttemptAt: Date, attempts: number): Promise<void>;
  markDeadLettered(eventId: string, attempts: number): Promise<void>;
  reconcile(now: Date): Promise<ReconciliationResult>;
}

export interface ReconciliationResult {
  readonly checked: number;
  readonly repaired: number;
  readonly pending: number;
  readonly durable: boolean;
}
