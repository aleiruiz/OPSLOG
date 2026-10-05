import { createHash, randomBytes } from 'node:crypto';

export type TenantId = string & { readonly __brand: 'TenantId' };
export type SubjectId = string & { readonly __brand: 'SubjectId' };
export type SessionId = string & { readonly __brand: 'SessionId' };
export type CorrelationId = string & { readonly __brand: 'CorrelationId' };
export type TenantStatus = 'provisioning' | 'active' | 'suspended' | 'failed';
export type MembershipStatus = 'pending' | 'active' | 'revoked';

export interface Tenant {
  readonly id: TenantId;
  readonly name: string;
  readonly status: TenantStatus;
  readonly createdAt: Date;
}
export interface TenantDatabaseLocation {
  readonly tenantId: TenantId;
  readonly databaseName: string;
  readonly credentialRef: string;
  readonly secretVersion: number;
  readonly migrationVersion: string;
  readonly runtimeRoleVerified: boolean;
  readonly isolationProbeVerified: boolean;
  readonly verifiedAt: Date;
}
export interface TenantProvisioningTarget {
  readonly tenantId: TenantId;
  readonly databaseName: string;
  readonly credentialRef: string;
  readonly secretVersion: number;
}
export interface Membership {
  readonly tenantId: TenantId;
  readonly subjectId: SubjectId;
  readonly status: MembershipStatus;
  readonly version: number;
}
export interface Session {
  readonly id: SessionId;
  readonly subjectId: SubjectId;
  readonly tenantId: TenantId;
  readonly authorizationVersion: number;
  readonly expiresAt: Date;
  readonly revoked: boolean;
}
export interface ProvisioningJob {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly status: 'pending' | 'running' | 'succeeded' | 'failed';
  readonly attempt: number;
  readonly errorCode?: string;
}
export interface Actor {
  readonly subjectId: SubjectId;
  readonly membershipVersion: number;
}
export interface TenantContext {
  readonly tenantId: TenantId;
  readonly actor: Actor;
  readonly authorizationVersion: number;
  readonly correlationId: CorrelationId;
  readonly database: TenantDatabaseLocation;
}

export class TenantAccessDeniedError extends Error {
  readonly code = 'TENANT_ACCESS_DENIED';
  constructor() {
    super('Tenant access denied');
    this.name = 'TenantAccessDeniedError';
  }
}
export class IdempotencyConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT';
  constructor() {
    super('Idempotency key was already used with a different request');
    this.name = 'IdempotencyConflictError';
  }
}
export class ProvisioningFailedError extends Error {
  readonly code = 'TENANT_PROVISIONING_FAILED';
  constructor(readonly reasonCode = 'PROVISIONING_FAILED') {
    super('Tenant provisioning failed');
    this.name = 'ProvisioningFailedError';
  }
}

export function opaqueTenantId(): TenantId {
  return uuidV7() as TenantId;
}
export function opaqueId(): string {
  return uuidV7();
}
export function uuidV7(now = Date.now()): string {
  if (!Number.isSafeInteger(now) || now < 0 || now > 0xffffffffffff)
    throw new RangeError('UUIDv7 timestamp must fit 48 bits');
  const bytes = randomBytes(16);
  let timestamp = now;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = timestamp & 0xff;
    timestamp = Math.floor(timestamp / 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function subjectId(value: string): SubjectId {
  if (!value.length) throw new Error('subject is required');
  return value as SubjectId;
}
export function correlationId(): CorrelationId {
  return uuidV7() as CorrelationId;
}
export function payloadHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function sessionIdHash(value: SessionId): string {
  return createHash('sha256').update(value).digest('hex');
}
export function immutableContext(value: TenantContext): TenantContext {
  Object.freeze(value.actor);
  Object.freeze(value.database);
  return Object.freeze(value);
}
