import { ProvisioningFailedError, type TenantProvisioningTarget } from '@opslog/domain-tenants';
import { TENANT_DATABASE_MIGRATION_VERSION } from './migrations.js';
import type { ProvisioningEvidence } from './provisioning.js';

export function isLockContention(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as {
    code?: unknown;
    errno?: unknown;
    driverError?: { code?: unknown; errno?: unknown };
  };
  return (
    candidate.code === 'ER_LOCK_DEADLOCK' ||
    candidate.code === 'ER_LOCK_WAIT_TIMEOUT' ||
    candidate.errno === 1213 ||
    candidate.errno === 1205 ||
    candidate.driverError?.code === 'ER_LOCK_DEADLOCK' ||
    candidate.driverError?.code === 'ER_LOCK_WAIT_TIMEOUT' ||
    candidate.driverError?.errno === 1213 ||
    candidate.driverError?.errno === 1205
  );
}
export function isDuplicateKey(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as {
    code?: unknown;
    errno?: unknown;
    driverError?: { code?: unknown; errno?: unknown };
  };
  return (
    candidate.code === 'ER_DUP_ENTRY' ||
    candidate.code === '23505' ||
    candidate.errno === 1062 ||
    candidate.driverError?.code === 'ER_DUP_ENTRY' ||
    candidate.driverError?.errno === 1062
  );
}
export function safeFailureCode(error: unknown): string {
  if (error instanceof ProvisioningFailedError) return error.reasonCode;
  if (typeof error !== 'object' || error === null) return 'PROVISIONING_FAILED';
  const candidate = error as { name?: unknown; driverError?: { code?: unknown }; code?: unknown };
  const raw = candidate.driverError?.code ?? candidate.code ?? candidate.name;
  if (typeof raw !== 'string') return 'PROVISIONING_FAILED';
  const normalized = raw.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  return normalized.length > 0 && normalized.length <= 64 ? normalized : 'PROVISIONING_FAILED';
}
export function isVerifiableEvidence(
  target: TenantProvisioningTarget,
  evidence: ProvisioningEvidence,
): boolean {
  return (
    evidence.tenantId === target.tenantId &&
    evidence.databaseName === target.databaseName &&
    evidence.credentialRef === target.credentialRef &&
    evidence.migrationVersion === TENANT_DATABASE_MIGRATION_VERSION &&
    evidence.runtimeRoleVerified &&
    evidence.isolationProbeVerified &&
    Number.isFinite(evidence.verifiedAt.getTime())
  );
}
export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
