import type { TenantId, TenantProvisioningTarget } from '@opslog/domain-tenants';

export interface ProvisioningEvidence {
  readonly tenantId: TenantId;
  readonly databaseName: string;
  readonly credentialRef: string;
  readonly migrationVersion: string;
  readonly runtimeRoleVerified: boolean;
  readonly isolationProbeVerified: boolean;
  readonly verifiedAt: Date;
}

export interface FencedTenantProvisioningTarget extends TenantProvisioningTarget {
  readonly attempt: number;
  readonly leaseOwner: string;
}

export interface TenantProvisioningBackend {
  createIsolatedDatabase(target: FencedTenantProvisioningTarget): Promise<void>;
  createLeastPrivilegeRuntimeCredential(target: FencedTenantProvisioningTarget): Promise<void>;
  runTenantMigrations(target: FencedTenantProvisioningTarget): Promise<string>;
  verifyRuntimeRole(target: FencedTenantProvisioningTarget): Promise<boolean>;
  verifyCrossTenantIsolation(target: FencedTenantProvisioningTarget): Promise<boolean>;
  rollback(target: FencedTenantProvisioningTarget): Promise<void>;
}

export class VerifiedTenantProvisioningAdapter {
  constructor(private readonly backend: TenantProvisioningBackend) {}

  async provision(target: FencedTenantProvisioningTarget): Promise<ProvisioningEvidence> {
    await this.backend.createIsolatedDatabase(target);
    await this.backend.createLeastPrivilegeRuntimeCredential(target);
    const migrationVersion = await this.backend.runTenantMigrations(target);
    const runtimeRoleVerified = await this.backend.verifyRuntimeRole(target);
    const isolationProbeVerified = await this.backend.verifyCrossTenantIsolation(target);
    return {
      tenantId: target.tenantId,
      databaseName: target.databaseName,
      credentialRef: target.credentialRef,
      migrationVersion,
      runtimeRoleVerified,
      isolationProbeVerified,
      verifiedAt: new Date(),
    };
  }

  rollback(target: FencedTenantProvisioningTarget): Promise<void> {
    return this.backend.rollback(target);
  }
}
