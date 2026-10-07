import type {
  Membership,
  ProvisioningJob,
  Session,
  SessionId,
  SubjectId,
  Tenant,
  TenantDatabaseLocation,
  TenantId,
  TenantStatus,
} from '@opslog/domain-tenants';
import type { VerifiedTenantProvisioningAdapter } from './provisioning.js';

export interface TenantStore {
  getTenant(id: TenantId): Promise<Tenant | undefined>;
  getMembership(tenantId: TenantId, subject: SubjectId): Promise<Membership | undefined>;
  getSession(id: SessionId): Promise<Session | undefined>;
  getLocation(id: TenantId): Promise<TenantDatabaseLocation | undefined>;
  getJob(tenantId: TenantId, idempotencyKey: string): Promise<ProvisioningJob | undefined>;
  projectMembership(
    tenantId: TenantId,
    subjectId: SubjectId,
    version: number,
    status: Membership['status'],
  ): Promise<Membership>;
  saveSession(session: Session): Promise<void>;
  setTenantStatus(tenantId: TenantId, status: TenantStatus): Promise<void>;
}

export interface TenantProvisioner {
  createAndProvision(
    request: { readonly name: string },
    idempotencyKey: string,
    adapter: VerifiedTenantProvisioningAdapter,
  ): Promise<Tenant>;
}

export interface UntrustedRequest {
  readonly sessionId: SessionId;
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly body?: unknown;
  readonly query?: unknown;
}
