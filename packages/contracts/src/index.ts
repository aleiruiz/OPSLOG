import type { ActorRef } from './identity.js';
import { actor, i, keys, r, t, u, type ContractValidationError } from './validation-support.js';

export type UUID = string;
export type ISODateTime = string;
export type Certainty = 'confirmed' | 'proposed' | 'assumption' | 'decision_required';
export interface PageQuery {
  limit?: 25 | 50 | 100;
  cursor?: string;
  sort?: string;
  direction?: 'asc' | 'desc';
}
export interface Page<T> {
  items: readonly T[];
  nextCursor: string | null;
  total: number;
  sort: { field: string; direction: 'asc' | 'desc' };
}
export interface EventEnvelope<T> {
  eventId: UUID;
  schemaVersion: number;
  tenantId: string;
  entityId: UUID;
  occurredAt: ISODateTime;
  actorRef: ActorRef;
  correlationId: string;
  payload: T;
}
export type IdempotencyScope = 'tenant:event';
export interface IdempotencyClaim {
  tenantId: string;
  eventId: UUID;
  key: string;
  scope: IdempotencyScope;
}
export interface OutboxRecord<T> extends EventEnvelope<T> {
  idempotencyKey: string;
}
export type WebhookEventName =
  | 'vehicle.created'
  | 'vehicle.updated'
  | 'vehicle.status_changed'
  | 'driver.created'
  | 'driver.updated'
  | 'driver.eligibility_changed'
  | 'incident.created'
  | 'incident.status_changed'
  | 'incident.closed'
  | 'maintenance.created'
  | 'maintenance.status_changed';
export interface WebhookDelivery {
  event: WebhookEventName;
  attempt: number;
  signature: string;
  status: 'pending' | 'delivered' | 'failed' | 'dead_letter';
  nextAttemptAt?: ISODateTime;
}
export type VehicleStatus =
  | 'active'
  | 'restricted'
  | 'maintenance'
  | 'out_of_service'
  | 'inactive'
  | 'retired';
export type IncidentStatus =
  | 'draft'
  | 'reported'
  | 'under_review'
  | 'insurance_process'
  | 'insurance_rejected'
  | 'repair'
  | 'closed'
  | 'reopened'
  | 'cancelled';
export type IncidentSeverity = 'critical' | 'high' | 'medium' | 'low';
export interface CreateIncidentInput {
  vehicleId: UUID;
  type: string;
  occurredAt?: ISODateTime;
  description?: string;
  driverId?: UUID;
  externalTripRef?: string;
}
export interface TransitionIncidentInput {
  to: IncidentStatus;
  comment?: string;
  reason?: string;
  approvalRef?: UUID;
}
export interface CloseIncidentChecklist {
  incidentId: UUID;
  completedRequirementIds: readonly string[];
  approvalRef?: UUID;
}
export interface ReopenIncidentInput {
  reason: string;
}
export interface ImportDryRunRequest {
  entity: 'vehicles' | 'drivers';
  fileId: UUID;
  allowPartial: boolean;
}
export interface ImportRowError {
  row: number;
  column?: string;
  code: string;
  message: string;
}
export interface ImportDryRunResult {
  acceptedRows: number;
  rejectedRows: number;
  errors: readonly ImportRowError[];
  snapshotVersion: number;
}
export interface EligibilityResult {
  entityId: UUID;
  eligible: boolean;
  reasons: readonly string[];
  evaluatedAt: ISODateTime;
}
export function validatePageQuery(v: unknown): ContractValidationError[] {
  if (!r(v)) return [{ path: '', code: 'invalid_type', message: 'Expected object' }];
  const e: ContractValidationError[] = [];
  if (v.limit !== undefined && v.limit !== 25 && v.limit !== 50 && v.limit !== 100)
    e.push({ path: 'limit', code: 'invalid_enum', message: 'limit must be 25,50,100' });
  if (v.cursor !== undefined && typeof v.cursor !== 'string')
    e.push({ path: 'cursor', code: 'invalid_type', message: 'cursor must be string' });
  if (v.direction !== undefined && v.direction !== 'asc' && v.direction !== 'desc')
    e.push({ path: 'direction', code: 'invalid_enum', message: 'direction must be asc or desc' });
  return e;
}
export function validateCreateIncident(v: unknown): ContractValidationError[] {
  if (!r(v)) return [{ path: '', code: 'invalid_type', message: 'Expected object' }];
  const e: ContractValidationError[] = [];
  keys(v, ['vehicleId', 'type', 'occurredAt', 'description', 'driverId', 'externalTripRef'], e);
  if (!u(v.vehicleId))
    e.push({ path: 'vehicleId', code: 'invalid_uuid', message: 'vehicleId must be UUID' });
  if (!t(v.type)) e.push({ path: 'type', code: 'required', message: 'type required' });
  if (v.occurredAt !== undefined && !i(v.occurredAt))
    e.push({
      path: 'occurredAt',
      code: 'invalid_datetime',
      message: 'occurredAt must be UTC ISO-8601',
    });
  if (v.driverId !== undefined && !u(v.driverId))
    e.push({ path: 'driverId', code: 'invalid_uuid', message: 'driverId must be UUID' });
  return e;
}
export function validateEventEnvelope(v: unknown): ContractValidationError[] {
  if (!r(v)) return [{ path: '', code: 'invalid_type', message: 'Expected object' }];
  const e: ContractValidationError[] = [];
  keys(
    v,
    [
      'eventId',
      'schemaVersion',
      'tenantId',
      'entityId',
      'occurredAt',
      'actorRef',
      'correlationId',
      'payload',
    ],
    e,
  );
  const f: Array<[string, boolean]> = [
    ['eventId', u(v.eventId)],
    ['tenantId', t(v.tenantId)],
    ['entityId', u(v.entityId)],
    ['occurredAt', i(v.occurredAt)],
    ['correlationId', t(v.correlationId)],
  ];
  for (const [path, ok] of f)
    if (!ok)
      e.push({ path, code: 'required_or_invalid', message: `${path} is missing or invalid` });
  if (!Number.isInteger(v.schemaVersion) || (v.schemaVersion as number) < 1)
    e.push({ path: 'schemaVersion', code: 'invalid_integer', message: 'schemaVersion positive' });
  if (!actor(v.actorRef))
    e.push({
      path: 'actorRef',
      code: 'invalid_actor',
      message: 'actorRef kind and subject are required',
    });
  if (!('payload' in v)) e.push({ path: 'payload', code: 'required', message: 'payload required' });
  return e;
}
export function validateOutboxRecord(v: unknown): ContractValidationError[] {
  if (!r(v)) return [{ path: '', code: 'invalid_type', message: 'Expected object' }];
  const { idempotencyKey, ...envelope } = v;
  const e = validateEventEnvelope(envelope);
  if (!t(idempotencyKey))
    e.push({ path: 'idempotencyKey', code: 'required', message: 'idempotencyKey required' });
  keys(
    v,
    [
      'eventId',
      'schemaVersion',
      'tenantId',
      'entityId',
      'occurredAt',
      'actorRef',
      'correlationId',
      'payload',
      'idempotencyKey',
    ],
    e,
  );
  return e;
}
export function validateIdempotencyClaim(v: unknown): ContractValidationError[] {
  if (!r(v)) return [{ path: '', code: 'invalid_type', message: 'Expected object' }];
  const e: ContractValidationError[] = [];
  keys(v, ['tenantId', 'eventId', 'key', 'scope'], e);
  if (!t(v.tenantId)) e.push({ path: 'tenantId', code: 'required', message: 'tenantId required' });
  if (!u(v.eventId))
    e.push({ path: 'eventId', code: 'invalid_uuid', message: 'eventId must be UUID' });
  if (!t(v.key)) e.push({ path: 'key', code: 'required', message: 'key required' });
  if (v.scope !== 'tenant:event')
    e.push({ path: 'scope', code: 'invalid_scope', message: 'scope must be tenant:event' });
  return e;
}
export * from './identity.js';
export * from './errors.js';
export * from './files.js';
export type { ContractValidationError } from './validation-support.js';
export * from './bff.js';
export * from './client.js';
