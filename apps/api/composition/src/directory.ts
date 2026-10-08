import type {
  IdentityMutationAudit,
  Permission,
} from '../../../../packages/domain/identity/src/index.js';
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

const isSystemRoleName = (name: string): boolean => {
  const wanted = name.trim().toLowerCase();
  return Object.values(ROLE_LABELS).some((label) => label.toLowerCase() === wanted);
};

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
      isSystemRoleName(name) ||
      this.custom(tenantId).some((role) => role.name.toLowerCase() === wanted)
    );
  }
  public add(tenantId: string, role: CustomRole): void {
    const roles = this.byTenant.get(tenantId) ?? new Map<string, CustomRole>();
    roles.set(role.id, role);
    this.byTenant.set(tenantId, roles);
  }
}

export type CreateRoleOutcome = 'created' | 'name_taken' | 'limit_reached';

/**
 * Port of the persistent role directory: custom roles of each tenant and the role of each
 * membership. `TypeOrmIdentityStore` (packages/persistence/identity) implements it, so the same
 * MySQL store that holds identities and memberships holds the roles, under the same tenant lock.
 * Every method is tenant-scoped; permissions travel as plain strings and are validated on the way back.
 */
export interface RoleDirectoryStore {
  listCustomRoles(
    tenantId: string,
  ): Promise<readonly { id: string; name: string; permissions: readonly string[] }[]>;
  findCustomRole(
    tenantId: string,
    roleId: string,
  ): Promise<{ id: string; name: string; permissions: readonly string[] } | null>;
  /** Atomically enforces name uniqueness and the per-tenant limit. */
  createCustomRole(
    tenantId: string,
    role: { id: string; name: string; permissions: readonly string[] },
    maxRoles: number,
  ): Promise<CreateRoleOutcome>;
  /** Persists the role of a pending or active membership; false when there is none. */
  setRole(tenantId: string, identityId: string, role: string): Promise<boolean>;
  /** Optional transactional variant for a durable tenant-local audit row and delivery state. */
  setRoleWithAudit?(
    tenantId: string,
    identityId: string,
    role: string,
    audit: IdentityMutationAudit,
  ): Promise<boolean>;
}

export const isRoleDirectoryStore = (value: unknown): value is RoleDirectoryStore =>
  typeof value === 'object' &&
  value !== null &&
  ['listCustomRoles', 'findCustomRole', 'createCustomRole', 'setRole'].every(
    (method) => typeof (value as Record<string, unknown>)[method] === 'function',
  );

const KNOWN_PERMISSIONS: ReadonlySet<string> = new Set(Object.values(ROLE_PERMISSIONS).flat());

/** Drops anything the composition does not know: a stored role can only ever grant fewer permissions. */
const knownPermissions = (permissions: readonly string[]): readonly Permission[] =>
  permissions.filter((permission): permission is Permission => KNOWN_PERMISSIONS.has(permission));

/**
 * Role directory seen by the platform: the persistent store when one is configured, the in-memory
 * `RoleCatalog` otherwise. System templates always come from the composition; only custom roles
 * and membership roles are persisted.
 */
export class RoleDirectory {
  public constructor(
    private readonly store?: RoleDirectoryStore,
    public readonly catalog: RoleCatalog = new RoleCatalog(),
  ) {}

  public get persistent(): boolean {
    return this.store !== undefined;
  }

  public async custom(tenantId: string): Promise<readonly CustomRole[]> {
    if (!this.store) return this.catalog.custom(tenantId);
    return (await this.store.listCustomRoles(tenantId)).map((role) => ({
      id: role.id,
      name: role.name,
      permissions: knownPermissions(role.permissions),
    }));
  }

  /** Looks up a role of this tenant only: system templates or the tenant's own custom roles. */
  public async find(
    tenantId: string,
    roleId: string,
  ): Promise<{ name: string; permissions: readonly Permission[] } | undefined> {
    if (!this.store || Object.hasOwn(ROLE_PERMISSIONS, roleId))
      return this.catalog.find(tenantId, roleId);
    const stored = await this.store.findCustomRole(tenantId, roleId);
    return stored
      ? { name: stored.name, permissions: knownPermissions(stored.permissions) }
      : undefined;
  }

  public async create(tenantId: string, role: CustomRole): Promise<CreateRoleOutcome> {
    if (!this.store) {
      if (
        this.catalog.nameTaken(tenantId, role.name) ||
        this.catalog.custom(tenantId).length >= MAX_CUSTOM_ROLES_PER_TENANT
      )
        return 'name_taken';
      this.catalog.add(tenantId, role);
      return 'created';
    }
    if (isSystemRoleName(role.name)) return 'name_taken';
    return this.store.createCustomRole(tenantId, role, MAX_CUSTOM_ROLES_PER_TENANT);
  }

  /** Writes a membership's role through to the store; true (nothing to do) without a store. */
  public async setMemberRole(
    tenantId: string,
    identityId: string,
    role: RoleName,
  ): Promise<boolean> {
    return this.store ? this.store.setRole(tenantId, identityId, role) : true;
  }

  public async setMemberRoleWithAudit(
    tenantId: string,
    identityId: string,
    role: RoleName,
    audit: IdentityMutationAudit,
  ): Promise<boolean> {
    if (!this.store) return true;
    if (!this.store.setRoleWithAudit) return false;
    return this.store.setRoleWithAudit(tenantId, identityId, role, audit);
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
