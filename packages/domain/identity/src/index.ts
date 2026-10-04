export type IdentityStatus = 'invited' | 'active' | 'blocked' | 'deactivated';
export type SystemRole =
  | 'company_admin'
  | 'fleet_manager'
  | 'dispatcher'
  | 'incident_manager'
  | 'mechanic'
  | 'supervisor'
  | 'viewer';
export type Permission =
  | 'manage_users'
  | 'manage_config'
  | 'view'
  | 'create'
  | 'edit'
  | 'delete'
  | 'export'
  | 'view_pii'
  | 'view_costs'
  | 'view_audit'
  | 'approve'
  | 'reopen'
  | 'incidents:report';

export interface IdentityUser {
  id: string;
  email: string;
  status: IdentityStatus;
  passwordHash: string | null;
  mfaRequired: boolean;
  mfaEnabled: boolean;
  mfaSecret: string | null;
  authorizationVersion: number;
}

export interface Membership {
  tenantId: string;
  userId: string;
  roles: readonly SystemRole[];
  permissions: readonly Permission[];
  owner: boolean;
  active: boolean;
}

export interface Invitation {
  id: string;
  tenantId: string;
  userId: string;
  tokenDigest: string;
  expiresAt: number;
  revokedAt: number | null;
  acceptedAt: number | null;
}

export interface Session {
  id: string;
  userId: string;
  tenantId: string;
  tokenDigest: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  revokedAt: number | null;
  authorizationVersion: number;
}

export interface PasswordReset {
  id: string;
  userId: string;
  tokenDigest: string;
  expiresAt: number;
  usedAt: number | null;
}

export interface IdentityRepository {
  getUser(id: string): IdentityUser | undefined;
  getUserByEmail(email: string): IdentityUser | undefined;
  getMembership(tenantId: string, userId: string): Membership | undefined;
  countActiveAdmins(tenantId: string): number;
  saveUser(user: IdentityUser): void;
  saveMembership(membership: Membership): void;
  saveInvitation(invitation: Invitation): void;
  getInvitationByDigest(digest: string): Invitation | undefined;
  saveSession(session: Session): void;
  getSessionByDigest(digest: string): Session | undefined;
  savePasswordReset(reset: PasswordReset): void;
  getPasswordResetByDigest(digest: string): PasswordReset | undefined;
  revokeUserSessions(userId: string): void;
  withLock<T>(work: () => T): T;
}

export interface CredentialPort {
  hashPassword(password: string): Promise<string>;
  verifyPassword(password: string, hash: string): Promise<boolean>;
  digestOpaque(value: string): string;
  randomOpaque(): string;
}

export interface MfaPort {
  verify(secret: string, code: string, now: number): boolean;
}

export class IdentityError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'IdentityError';
  }
}

const adminRoles = new Set<SystemRole>(['company_admin']);
const defaultPermissions: Record<SystemRole, readonly Permission[]> = {
  company_admin: [
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
  fleet_manager: ['view', 'create', 'edit', 'export', 'view_pii', 'view_costs'],
  dispatcher: ['view', 'create', 'edit', 'incidents:report'],
  incident_manager: [
    'view',
    'create',
    'edit',
    'view_costs',
    'approve',
    'reopen',
    'incidents:report',
  ],
  mechanic: ['view', 'edit'],
  supervisor: ['view', 'approve', 'view_costs', 'view_audit'],
  viewer: ['view'],
};
const normalized = (email: string) => email.trim().toLowerCase();
const assertPassword = (password: string) => {
  if (
    password.length < 12 ||
    !/[a-z]/.test(password) ||
    !/[A-Z]/.test(password) ||
    !/[0-9]/.test(password)
  )
    throw new IdentityError('weak_password', 'Password does not satisfy policy');
};

export class IdentityService {
  public constructor(
    private readonly repo: IdentityRepository,
    private readonly crypto: CredentialPort,
    private readonly mfa?: MfaPort,
  ) {}

  public async invite(
    actorUserId: string,
    tenantId: string,
    email: string,
    now: number,
    roles: readonly SystemRole[] = [],
  ): Promise<{ invitationId: string; token: string }> {
    this.requirePermission(actorUserId, tenantId, 'manage_users');
    const address = normalized(email);
    if (!address.includes('@')) throw new IdentityError('invalid_email', 'Email is invalid');
    const existing = this.repo.getUserByEmail(address);
    const user: IdentityUser = existing ?? {
      id: this.crypto.randomOpaque(),
      email: address,
      status: 'invited',
      passwordHash: null,
      mfaRequired: false,
      mfaEnabled: false,
      mfaSecret: null,
      authorizationVersion: 1,
    };
    if (existing && existing.status === 'active')
      throw new IdentityError('already_active', 'User is already active');
    user.status = 'invited';
    this.repo.saveUser(user);
    this.repo.saveMembership({
      tenantId,
      userId: user.id,
      roles: [...roles],
      permissions: [...new Set(roles.flatMap((role) => defaultPermissions[role]))],
      owner: false,
      active: false,
    });
    const token = this.crypto.randomOpaque();
    this.repo.saveInvitation({
      id: this.crypto.randomOpaque(),
      tenantId,
      userId: user.id,
      tokenDigest: this.crypto.digestOpaque(token),
      expiresAt: now + 72 * 60 * 60 * 1000,
      revokedAt: null,
      acceptedAt: null,
    });
    return { invitationId: user.id, token };
  }

  public async acceptInvitation(
    token: string,
    password: string,
    now: number,
  ): Promise<IdentityUser> {
    assertPassword(password);
    const invitation = this.repo.getInvitationByDigest(this.crypto.digestOpaque(token));
    if (
      !invitation ||
      invitation.revokedAt !== null ||
      invitation.acceptedAt !== null ||
      invitation.expiresAt <= now
    )
      throw new IdentityError('invalid_invitation', 'Invitation is invalid or expired');
    const user = this.repo.getUser(invitation.userId);
    if (!user || user.status !== 'invited')
      throw new IdentityError('invalid_invitation', 'Invitation is invalid or expired');
    user.passwordHash = await this.crypto.hashPassword(password);
    user.status = 'active';
    this.repo.saveUser(user);
    const membership = this.repo.getMembership(invitation.tenantId, user.id);
    if (membership) {
      membership.active = membership.roles.length > 0;
      this.repo.saveMembership(membership);
    }
    invitation.acceptedAt = now;
    this.repo.saveInvitation(invitation);
    return user;
  }

  public revokeInvitation(actorUserId: string, tenantId: string, token: string, now: number): void {
    this.requirePermission(actorUserId, tenantId, 'manage_users');
    const invitation = this.repo.getInvitationByDigest(this.crypto.digestOpaque(token));
    if (invitation && invitation.tenantId === tenantId && invitation.revokedAt === null) {
      invitation.revokedAt = now;
      this.repo.saveInvitation(invitation);
    }
  }

  public setRoles(
    actorUserId: string,
    tenantId: string,
    targetUserId: string,
    roles: readonly SystemRole[],
  ): void {
    this.requirePermission(actorUserId, tenantId, 'manage_users');
    const membership = this.repo.getMembership(tenantId, targetUserId);
    if (!membership) throw new IdentityError('not_found', 'Membership not found');
    this.repo.withLock(() => {
      const removingAdmin =
        membership.roles.some((role) => adminRoles.has(role)) &&
        !roles.some((role) => adminRoles.has(role));
      if (removingAdmin && this.repo.countActiveAdmins(tenantId) <= 1)
        throw new IdentityError('last_admin', 'The tenant must retain an administrator');
      membership.roles = [...roles];
      membership.permissions = [...new Set(roles.flatMap((role) => defaultPermissions[role]))];
      this.repo.saveMembership(membership);
      const user = this.repo.getUser(targetUserId);
      if (user) {
        user.authorizationVersion += 1;
        this.repo.saveUser(user);
        this.repo.revokeUserSessions(targetUserId);
      }
    });
  }

  public deactivate(actorUserId: string, tenantId: string, targetUserId: string): void {
    this.requirePermission(actorUserId, tenantId, 'manage_users');
    this.repo.withLock(() => {
      const membership = this.repo.getMembership(tenantId, targetUserId);
      if (!membership) throw new IdentityError('not_found', 'Membership not found');
      if (
        membership.roles.some((role) => adminRoles.has(role)) &&
        this.repo.countActiveAdmins(tenantId) <= 1
      )
        throw new IdentityError('last_admin', 'The tenant must retain an administrator');
      membership.active = false;
      this.repo.saveMembership(membership);
      const user = this.repo.getUser(targetUserId);
      if (user) {
        user.status = 'deactivated';
        user.authorizationVersion += 1;
        this.repo.saveUser(user);
        this.repo.revokeUserSessions(targetUserId);
      }
    });
  }

  public authorize(
    userId: string,
    tenantId: string,
    permission: Permission,
    targetOwnerId?: string,
  ): void {
    const membership = this.repo.getMembership(tenantId, userId);
    if (!membership?.active || !membership.permissions.includes(permission))
      throw new IdentityError('forbidden', 'Permission denied');
    if (
      targetOwnerId !== undefined &&
      targetOwnerId !== userId &&
      !membership.permissions.includes('manage_users')
    )
      throw new IdentityError('forbidden', 'Ownership required');
  }

  public async authenticate(
    email: string,
    password: string,
    tenantId: string,
    now: number,
    mfaCode?: string,
  ): Promise<{ userId: string; token: string }> {
    const user = this.repo.getUserByEmail(normalized(email));
    if (
      !user ||
      user.status !== 'active' ||
      !user.passwordHash ||
      !(await this.crypto.verifyPassword(password, user.passwordHash))
    )
      throw new IdentityError('invalid_credentials', 'Invalid credentials');
    const membership = this.repo.getMembership(tenantId, user.id);
    if (!membership?.active || membership.permissions.length === 0)
      throw new IdentityError('forbidden', 'Permission denied');
    if (
      (user.mfaRequired || user.mfaEnabled) &&
      (!mfaCode || !this.mfa || !user.mfaSecret || !this.mfa.verify(user.mfaSecret, mfaCode, now))
    )
      throw new IdentityError('mfa_required', 'MFA verification required');
    const token = this.crypto.randomOpaque();
    this.repo.saveSession({
      id: this.crypto.randomOpaque(),
      userId: user.id,
      tenantId,
      tokenDigest: this.crypto.digestOpaque(token),
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + 8 * 60 * 60 * 1000,
      revokedAt: null,
      authorizationVersion: user.authorizationVersion,
    });
    return { userId: user.id, token };
  }

  public validateSession(token: string, now: number): Session {
    const session = this.repo.getSessionByDigest(this.crypto.digestOpaque(token));
    const user = session && this.repo.getUser(session.userId);
    if (
      !session ||
      !user ||
      session.revokedAt !== null ||
      user.status !== 'active' ||
      session.expiresAt <= now ||
      session.lastSeenAt + 8 * 60 * 60 * 1000 <= now ||
      session.authorizationVersion !== user.authorizationVersion
    )
      throw new IdentityError('unauthorized', 'Session is not valid');
    session.lastSeenAt = now;
    this.repo.saveSession(session);
    return session;
  }

  public logout(token: string, now: number): void {
    const session = this.repo.getSessionByDigest(this.crypto.digestOpaque(token));
    if (session) {
      session.revokedAt = now;
      this.repo.saveSession(session);
    }
  }

  public configureMfa(userId: string, tenantId: string, secret: string, required: boolean): void {
    this.authorize(userId, tenantId, 'manage_users');
    const user = this.repo.getUser(userId);
    if (!user) throw new IdentityError('not_found', 'User not found');
    user.mfaSecret = secret;
    user.mfaEnabled = true;
    user.mfaRequired = required;
    user.authorizationVersion += 1;
    this.repo.saveUser(user);
    this.repo.revokeUserSessions(userId);
  }

  public requestPasswordReset(
    email: string,
    now: number,
  ): { token: string | null; resetId: string | null } {
    const user = this.repo.getUserByEmail(normalized(email));
    if (!user || user.status !== 'active') return { token: null, resetId: null };
    const token = this.crypto.randomOpaque();
    const resetId = this.crypto.randomOpaque();
    this.repo.savePasswordReset({
      id: resetId,
      userId: user.id,
      tokenDigest: this.crypto.digestOpaque(token),
      expiresAt: now + 60 * 60 * 1000,
      usedAt: null,
    });
    return { token, resetId };
  }

  public async resetPassword(token: string, password: string, now: number): Promise<void> {
    assertPassword(password);
    const reset = this.repo.getPasswordResetByDigest(this.crypto.digestOpaque(token));
    const user = reset && this.repo.getUser(reset.userId);
    if (
      !reset ||
      !user ||
      reset.usedAt !== null ||
      reset.expiresAt <= now ||
      user.status !== 'active'
    )
      throw new IdentityError('invalid_reset', 'Reset token is invalid or expired');
    user.passwordHash = await this.crypto.hashPassword(password);
    user.authorizationVersion += 1;
    this.repo.saveUser(user);
    this.repo.revokeUserSessions(user.id);
    reset.usedAt = now;
    this.repo.savePasswordReset(reset);
  }

  private requirePermission(userId: string, tenantId: string, permission: Permission): void {
    this.authorize(userId, tenantId, permission);
  }
}

export { defaultPermissions };
