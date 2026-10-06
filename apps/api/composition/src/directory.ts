import type { Permission } from '../../../../packages/domain/identity/src/index.js';
import { ROLE_PERMISSIONS, type RoleName } from './access.js';

export const ROLE_LABELS: Readonly<Record<RoleName, string>> = {
  admin: 'Administrador',
  editor: 'Editor',
  viewer: 'Consulta',
  auditor: 'Auditoría',
  pii_reader: 'Lectura de datos personales',
};

export type MfaPolicy = 'disabled' | 'optional' | 'required';
export const MFA_POLICIES: readonly MfaPolicy[] = ['disabled', 'optional', 'required'];

export interface TenantSettings {
  readonly name: string;
  readonly mfa: MfaPolicy;
  readonly sessionIdleHours: number;
}

/** Per-tenant company settings. Recorded and audited, not yet enforced by the identity service. */
export class TenantSettingsStore {
  private readonly byTenant = new Map<string, TenantSettings>();
  public get(tenantId: string, defaultName: string): TenantSettings {
    return (
      this.byTenant.get(tenantId) ?? { name: defaultName, mfa: 'disabled', sessionIdleHours: 8 }
    );
  }
  public set(tenantId: string, settings: TenantSettings): void {
    this.byTenant.set(tenantId, settings);
  }
}

export interface CustomRole {
  readonly id: string;
  readonly name: string;
  readonly permissions: readonly Permission[];
}

export const MAX_CUSTOM_ROLES_PER_TENANT = 50;

/**
 * Custom roles of each tenant (copies of system templates). In-memory stand-in for the persistent
 * role directory; custom roles cannot be assigned to members yet.
 */
export class RoleCatalog {
  private readonly byTenant = new Map<string, Map<string, CustomRole>>();
  public custom(tenantId: string): readonly CustomRole[] {
    return [...(this.byTenant.get(tenantId)?.values() ?? [])];
  }
  /** Looks up a role of this tenant only: system templates or the tenant's own custom roles. */
  public find(
    tenantId: string,
    roleId: string,
  ): { name: string; permissions: readonly Permission[] } | undefined {
    if (Object.hasOwn(ROLE_PERMISSIONS, roleId))
      return {
        name: ROLE_LABELS[roleId as RoleName],
        permissions: ROLE_PERMISSIONS[roleId as RoleName],
      };
    return this.byTenant.get(tenantId)?.get(roleId);
  }
  public nameTaken(tenantId: string, name: string): boolean {
    const wanted = name.trim().toLowerCase();
    return (
      Object.values(ROLE_LABELS).some((label) => label.toLowerCase() === wanted) ||
      this.custom(tenantId).some((role) => role.name.toLowerCase() === wanted)
    );
  }
  public add(tenantId: string, role: CustomRole): void {
    const roles = this.byTenant.get(tenantId) ?? new Map<string, CustomRole>();
    roles.set(role.id, role);
    this.byTenant.set(tenantId, roles);
  }
}

export type DraftValues = Readonly<Record<string, string>>;
export interface DraftRecord {
  readonly scope: string;
  readonly values: DraftValues;
  readonly savedAt: Date;
}

export const MAX_DRAFTS_PER_ACTOR = 100;

const draftKey = (tenantId: string, identityId: string): string =>
  `${tenantId.length}:${tenantId}${identityId.length}:${identityId}`;

/** Server-side drafts, keyed by tenant and actor so one person's drafts are never visible to another. */
export class DraftStore {
  private readonly byActor = new Map<string, Map<string, DraftRecord>>();
  public load(tenantId: string, identityId: string, scope: string): DraftRecord | null {
    return this.byActor.get(draftKey(tenantId, identityId))?.get(scope) ?? null;
  }
  /** False when the actor already holds the maximum number of drafts and this scope is new. */
  public save(tenantId: string, identityId: string, record: DraftRecord): boolean {
    const key = draftKey(tenantId, identityId);
    const drafts = this.byActor.get(key) ?? new Map<string, DraftRecord>();
    if (!drafts.has(record.scope) && drafts.size >= MAX_DRAFTS_PER_ACTOR) return false;
    drafts.set(record.scope, record);
    this.byActor.set(key, drafts);
    return true;
  }
  public discard(tenantId: string, identityId: string, scope: string): void {
    this.byActor.get(draftKey(tenantId, identityId))?.delete(scope);
  }
}
