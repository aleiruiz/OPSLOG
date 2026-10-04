import {
  assertTenantActive,
  completeProvisioning,
  failProvisioning,
  startProvisioning,
  type TenantRecord,
} from '../../../../packages/domain/tenants/src/index.js';

export interface TenantControlStore {
  get(tenantId: string): Promise<TenantRecord | undefined>;
  put(tenant: TenantRecord): Promise<void>;
}

export interface TenantDatabaseProvisioner {
  provision(tenant: TenantRecord): Promise<void>;
}

export interface AuthenticatedTenantRequest {
  readonly sessionTenantId: string;
  readonly authorizationVersion: number;
  readonly requestedTenantId?: string;
}

export class TenantHttpError extends Error {
  public readonly status: 404 | 409 | 422;
  public constructor(status: 404 | 409 | 422, message: string) {
    super(message);
    this.name = 'TenantHttpError';
    this.status = status;
  }
}

export function resolveTenantFromSession(request: AuthenticatedTenantRequest): string {
  if (request.requestedTenantId !== undefined && request.requestedTenantId !== request.sessionTenantId) {
    throw new TenantHttpError(404, 'tenant not found');
  }
  return request.sessionTenantId;
}

export class TenantApplicationService {
  private readonly locks = new Map<string, Promise<void>>();

  public constructor(private readonly store: TenantControlStore, private readonly provisioner: TenantDatabaseProvisioner) {}

  public async provision(tenantId: string): Promise<TenantRecord> {
    const previous = this.locks.get(tenantId) ?? Promise.resolve();
    const operation = previous.then(async () => {
      const current = await this.store.get(tenantId);
      if (!current) throw new TenantHttpError(404, 'tenant not found');
      if (current.status === 'active') return current;
      const started = startProvisioning(current).tenant;
      await this.store.put(started);
      try {
        await this.provisioner.provision(started);
        const active = completeProvisioning(started).tenant;
        await this.store.put(active);
        return active;
      } catch (error) {
        const failed = failProvisioning(started, 'provisioning_failed').tenant;
        await this.store.put(failed);
        throw error;
      }
    });
    const lock = operation.then(() => undefined, () => undefined);
    this.locks.set(tenantId, lock);
    try { return await operation; } finally { if (this.locks.get(tenantId) === lock) this.locks.delete(tenantId); }
  }

  public async requireActive(request: AuthenticatedTenantRequest): Promise<TenantRecord> {
    const tenantId = resolveTenantFromSession(request);
    const tenant = await this.store.get(tenantId);
    if (!tenant) throw new TenantHttpError(404, 'tenant not found');
    if (tenant.authorizationVersion !== request.authorizationVersion) throw new TenantHttpError(409, 'authorization changed');
    try { assertTenantActive(tenant); } catch { throw new TenantHttpError(409, 'tenant is not active'); }
    return Object.freeze({ ...tenant });
  }
}
