import {
  TenantContextResolver,
  type TenantProvisioner,
  type TenantStore,
  type UntrustedRequest,
  type VerifiedTenantProvisioningAdapter,
} from '@opslog/persistence-tenancy';
import type { Tenant, TenantContext } from '@opslog/domain-tenants';
export class TenantControlPlane {
  private readonly resolver: TenantContextResolver;
  constructor(
    private readonly provisioner: TenantProvisioner,
    store: TenantStore,
    private readonly adapter: VerifiedTenantProvisioningAdapter,
  ) {
    this.resolver = new TenantContextResolver(store);
  }
  provision(request: { readonly name: string }, idempotencyKey: string): Promise<Tenant> {
    return this.provisioner.createAndProvision(request, idempotencyKey, this.adapter);
  }
  resolveContext(request: UntrustedRequest): Promise<TenantContext> {
    return this.resolver.resolve(request);
  }
}
