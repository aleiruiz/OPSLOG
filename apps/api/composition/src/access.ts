import type {
  IdentityAccessResolver,
  Permission,
  TenantContext,
} from '../../../../packages/domain/identity/src/index.js';

export type RoleName = 'admin' | 'editor' | 'viewer' | 'auditor' | 'pii_reader';

/** Synthetic role templates for the composition; the real catalog belongs to the roles slice. */
export const ROLE_PERMISSIONS: Readonly<Record<RoleName, readonly Permission[]>> = {
  admin: [
    'manage_users',
    'manage_config',
    'view',
    'create',
    'edit',
    'delete',
    'export',
    'view_pii',
    'view_costs',
    'view_audit',
    'approve',
    'reopen',
    'incidents:report',
  ],
  editor: ['view', 'create', 'edit'],
  viewer: ['view'],
  auditor: ['view', 'view_audit'],
  pii_reader: ['view', 'create', 'view_pii'],
};

export const isRoleName = (value: unknown): value is RoleName =>
  typeof value === 'string' && Object.hasOwn(ROLE_PERMISSIONS, value);

interface Member {
  readonly tenantId: string;
  readonly identityId: string;
  readonly role: RoleName;
  readonly status: 'active' | 'revoked';
}

export interface MemberRow {
  readonly identityId: string;
  readonly role: RoleName;
  readonly status: 'active' | 'revoked' | 'pending';
}

/**
 * Reads the role stored for a membership by the persistent identity store. The store is the
 * source of truth: another process may have changed the role since the directory was written.
 */
export interface StoredRoleReader {
  findRole(tenantId: string, identityId: string): Promise<string | null>;
}

export const isStoredRoleReader = (value: unknown): value is StoredRoleReader =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Record<string, unknown>)['findRole'] === 'function';

const key = (tenantId: string, identityId: string): string =>
  `${tenantId.length}:${tenantId}${identityId.length}:${identityId}`;

/**
 * Server-side membership and role directory. It is the only source of effective permissions:
 * nothing about tenant or role is ever read from caller input. In-memory double for the port
 * that the persistent membership/role adapter must implement.
 */
export class AccessDirectory implements IdentityAccessResolver {
  private readonly members = new Map<string, Member>();
  private readonly tenantsOf = new Map<string, Set<string>>();
  private readonly pending = new Map<string, { tenantId: string; role: RoleName }>();
  public constructor(
    private readonly tenantIsActive: (tenantId: string) => boolean,
    private readonly stored?: StoredRoleReader,
  ) {}

  /** Records the role an invitation will grant once it is activated. */
  public expectInvitation(identityId: string, tenantId: string, role: RoleName): void {
    this.pending.set(identityId, { tenantId, role });
  }
  /** Activates the role of an accepted invitation; false when no matching invitation was recorded. */
  public activate(identityId: string, tenantId: string): boolean {
    const expected = this.pending.get(identityId);
    if (expected?.tenantId !== tenantId) return false;
    this.pending.delete(identityId);
    this.set({ tenantId, identityId, role: expected.role, status: 'active' });
    return true;
  }
  /** Rebuilds this process's directory from the role persisted by the activation transaction. */
  public async activateFromStore(identityId: string, tenantId: string): Promise<boolean> {
    if (!this.stored) return false;
    const role = await this.stored.findRole(tenantId, identityId);
    if (!isRoleName(role)) return false;
    this.pending.delete(identityId);
    this.grant(tenantId, identityId, role);
    return true;
  }
  /** Drops an invitation that has not been activated; false when none is recorded for this tenant. */
  public revokePending(identityId: string, tenantId: string): boolean {
    if (this.pending.get(identityId)?.tenantId !== tenantId) return false;
    return this.pending.delete(identityId);
  }
  /** Direct grant for bootstrap flows (first administrator). */
  public grant(tenantId: string, identityId: string, role: RoleName): void {
    this.set({ tenantId, identityId, role, status: 'active' });
  }
  public setRole(tenantId: string, identityId: string, role: RoleName): boolean {
    const current = this.members.get(key(tenantId, identityId));
    if (current?.status !== 'active') return false;
    this.set({ tenantId, identityId, role, status: 'active' });
    return true;
  }
  public revoke(tenantId: string, identityId: string): boolean {
    const current = this.members.get(key(tenantId, identityId));
    if (current?.status !== 'active') return false;
    this.set({ ...current, status: 'revoked' });
    return true;
  }
  public roleOf(tenantId: string, identityId: string): RoleName | null {
    const current = this.members.get(key(tenantId, identityId));
    return current?.status === 'active' ? current.role : null;
  }
  /** Members of one tenant, including invitations that have not been accepted yet. */
  public membersOf(tenantId: string): readonly MemberRow[] {
    const rows: MemberRow[] = [...this.members.values()]
      .filter((member) => member.tenantId === tenantId)
      .map((member) => ({
        identityId: member.identityId,
        role: member.role,
        status: member.status,
      }));
    for (const [identityId, expected] of this.pending)
      if (expected.tenantId === tenantId)
        rows.push({ identityId, role: expected.role, status: 'pending' });
    return rows;
  }
  /** True while an invitation recorded for this identity and tenant has not been activated. */
  public hasPending(identityId: string, tenantId: string): boolean {
    return this.pending.get(identityId)?.tenantId === tenantId;
  }
  public activeAdmins(tenantId: string): readonly string[] {
    return [...this.members.values()]
      .filter(
        (member) =>
          member.tenantId === tenantId && member.status === 'active' && member.role === 'admin',
      )
      .map((member) => member.identityId);
  }
  private set(member: Member): void {
    this.members.set(key(member.tenantId, member.identityId), member);
    const tenants = this.tenantsOf.get(member.identityId) ?? new Set<string>();
    tenants.add(member.tenantId);
    this.tenantsOf.set(member.identityId, tenants);
  }

  /**
   * The role the caller may use: the directory role, confirmed against the persistent store when
   * one is configured. A disagreement (for example a role changed by another process) fails
   * closed: no role, so no permissions and no sign-in until the directory is brought up to date.
   */
  public async effectiveRole(tenantId: string, identityId: string): Promise<RoleName | null> {
    const role = this.roleOf(tenantId, identityId);
    if (!role || !this.stored) return role;
    return (await this.stored.findRole(tenantId, identityId)) === role ? role : null;
  }

  public async resolveActiveTenant(identityId: string): Promise<string | null> {
    for (const tenantId of this.tenantsOf.get(identityId) ?? [])
      if ((await this.effectiveRole(tenantId, identityId)) && this.tenantIsActive(tenantId))
        return tenantId;
    return null;
  }
  public async resolvePermissions(context: TenantContext): Promise<readonly Permission[]> {
    const role = await this.effectiveRole(context.tenantId, context.actor.subject);
    return role ? ROLE_PERMISSIONS[role] : [];
  }
}
