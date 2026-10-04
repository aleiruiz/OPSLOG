export type TenantId = string;

export type TenantStatus = 'provisioning' | 'active' | 'failed' | 'suspended';

export interface TenantSettings {
  readonly country: string;
  readonly timezone: string;
  readonly currency: string;
  readonly language: string;
}

export interface TenantRecord {
  readonly id: TenantId;
  readonly name: string;
  readonly status: TenantStatus;
  readonly settings: TenantSettings;
  readonly authorizationVersion: number;
  readonly provisioningAttempt: number;
  readonly failureCode?: string;
}

export type TenantEvent =
  | { readonly type: 'provisioning_started'; readonly attempt: number }
  | { readonly type: 'provisioned'; readonly attempt: number }
  | { readonly type: 'provisioning_failed'; readonly attempt: number; readonly code: string }
  | { readonly type: 'suspended'; readonly authorizationVersion: number };

export class TenantStateError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'TenantStateError';
  }
}

export function startProvisioning(tenant: TenantRecord): { tenant: TenantRecord; event: TenantEvent } {
  if (tenant.status === 'active') return { tenant, event: { type: 'provisioned', attempt: tenant.provisioningAttempt } };
  if (tenant.status === 'suspended') throw new TenantStateError('suspended tenant cannot be provisioned');
  const attempt = tenant.provisioningAttempt + 1;
  const withoutFailure = { ...tenant };
  delete withoutFailure.failureCode;
  return {
    tenant: { ...withoutFailure, status: 'provisioning', provisioningAttempt: attempt },
    event: { type: 'provisioning_started', attempt },
  };
}

export function completeProvisioning(tenant: TenantRecord): { tenant: TenantRecord; event: TenantEvent } {
  if (tenant.status !== 'provisioning') throw new TenantStateError('tenant is not provisioning');
  const withoutFailure = { ...tenant };
  delete withoutFailure.failureCode;
  return {
    tenant: { ...withoutFailure, status: 'active' },
    event: { type: 'provisioned', attempt: tenant.provisioningAttempt },
  };
}

export function failProvisioning(tenant: TenantRecord, code: string): { tenant: TenantRecord; event: TenantEvent } {
  if (tenant.status !== 'provisioning') throw new TenantStateError('tenant is not provisioning');
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(code)) throw new TenantStateError('invalid provisioning failure code');
  return {
    tenant: { ...tenant, status: 'failed', failureCode: code },
    event: { type: 'provisioning_failed', attempt: tenant.provisioningAttempt, code },
  };
}

export function suspendTenant(tenant: TenantRecord): { tenant: TenantRecord; event: TenantEvent } {
  if (tenant.status !== 'active') throw new TenantStateError('only an active tenant can be suspended');
  const authorizationVersion = tenant.authorizationVersion + 1;
  return {
    tenant: { ...tenant, status: 'suspended', authorizationVersion },
    event: { type: 'suspended', authorizationVersion },
  };
}

export function assertTenantActive(tenant: TenantRecord): void {
  if (tenant.status !== 'active') throw new TenantStateError('tenant is not active');
}
