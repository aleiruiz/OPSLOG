import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { IsNull, LessThan, MoreThan, type DataSource, type EntityManager } from 'typeorm';
import {
  AuthError,
  type ExternalIdentity,
  type Identity,
  type IdentityStore,
  type Invitation,
  type InvitationActivation,
  type Membership,
  type RecoveryRequest,
  type Session,
} from '../../../domain/identity/src/index.js';
import { IDENTITY_RUNTIME_ACCOUNT } from './data-source.js';
import {
  ExternalIdentityEntity,
  IdentityEntity,
  InvitationEntity,
  MembershipEntity,
  RecoveryEntity,
  RoleEntity,
  RolePermissionEntity,
  SessionEntity,
  TenantLockEntity,
} from './entities.js';
import {
  IdentityStoreError,
  LastAdministratorError,
  isDuplicateKey,
  isLockContention,
  isMissingParent,
  sanitizeStoreError,
} from './errors.js';
import { ADMIN_ROLE, CUSTOM_ROLE_LIMITS, DEFAULT_ROLE, isRoleName } from './role-model.js';
import type { CreateCustomRoleOutcome, CustomRoleRecord } from './role-model.js';
import type { StoreErrorEvent, TypeOrmIdentityStoreOptions } from './store-types.js';
import {
  ActivationRejected,
  HASH_PATTERN,
  PERMISSION_PATTERN,
  ROLE_ID_PATTERN,
  invalid,
  isDate,
  lock,
  nonBlank,
} from './store-support.js';
import {
  toCustomRole,
  toExternal,
  toIdentity,
  toMembership,
  toRecovery,
  toSession,
} from './row-mappers.js';

/**
 * Persistent TypeORM/MySQL implementation of the `IdentityStore` port.
 *
 * - Multi-statement operations run in one READ COMMITTED transaction; single-statement ones are atomic.
 * - Row lock order is always tenant lock, identity, membership, then dependent rows, so the
 *   transactions that touch the same identity never wait on each other in a cycle.
 * - The last-administrator rule is enforced under the per-tenant lock row, so it holds across
 *   processes: of two concurrent removals of the final two administrators exactly one wins.
 * - Driver errors never leave this class: they are mapped to `AuthError` or to the sanitized
 *   `IdentityStoreError` (no SQL, parameters or subjects).
 */
export class TypeOrmIdentityStore implements IdentityStore {
  private readonly now: () => Date;
  private readonly maxAttempts: number;
  private readonly onError: ((event: StoreErrorEvent) => void) | undefined;

  public constructor(
    private readonly dataSource: DataSource,
    options: TypeOrmIdentityStoreOptions = {},
  ) {
    if (dataSource.options.type !== 'mysql' || dataSource.options.synchronize === true)
      throw new Error('Identity store requires MySQL with synchronize disabled');
    const username = dataSource.options.username;
    if (typeof username !== 'string' || !IDENTITY_RUNTIME_ACCOUNT.test(username))
      throw new Error('Identity store requires its restricted runtime account');
    this.now = options.now ?? (() => new Date());
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.onError = options.onError;
  }

  // ---- plumbing -----------------------------------------------------------------------------

  private fail(operation: string, error: unknown): Error {
    const safe = sanitizeStoreError(error);
    if (safe instanceof IdentityStoreError)
      this.onError?.({
        operation,
        code: safe.code,
        errno: safe.errno,
        origin: safe.origin,
        frames: safe.frames,
      });
    return safe;
  }

  /** Single-statement (autocommit) work with sanitized errors. */
  private async single<T>(operation: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw this.fail(operation, error);
    }
  }

  /** One READ COMMITTED transaction, retried only for deadlocks and lock-wait timeouts. */
  private async transaction<T>(
    operation: string,
    work: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.dataSource.transaction('READ COMMITTED', work);
      } catch (error) {
        if (isLockContention(error) && attempt < this.maxAttempts) continue;
        throw this.fail(operation, error);
      }
    }
  }

  /** Creates the tenant's lock row if missing (autocommit, outside the transaction that will lock it). */
  private async ensureTenantLock(operation: string, tenantId: string): Promise<void> {
    await this.single(operation, async () => {
      const locks = this.dataSource.getRepository(TenantLockEntity);
      if (await locks.findOneBy({ tenantId })) return;
      try {
        await locks.insert({ tenantId, createdAt: this.now() });
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
      }
    });
  }

  private async lockTenant(manager: EntityManager, tenantId: string): Promise<void> {
    const row = await manager
      .getRepository(TenantLockEntity)
      .findOne({ where: { tenantId }, lock });
    if (!row) throw new IdentityStoreError('integrity');
  }

  /** Counts active administrators under row locks; throws unless the tenant keeps at least one other. */
  private async assertAnotherAdmin(manager: EntityManager, tenantId: string): Promise<void> {
    const admins = await manager
      .getRepository(MembershipEntity)
      .find({ where: { tenantId, role: ADMIN_ROLE, status: 'active' }, lock });
    if (admins.length <= 1) throw new LastAdministratorError();
  }

  // ---- identities ---------------------------------------------------------------------------

  public async findIdentity(id: string): Promise<Identity | null> {
    if (!nonBlank(id, 64)) return null;
    return this.single('findIdentity', async () => {
      const row = await this.dataSource.getRepository(IdentityEntity).findOneBy({ id });
      return row ? toIdentity(row) : null;
    });
  }

  public async findExternal(provider: string, subject: string): Promise<ExternalIdentity | null> {
    if (!nonBlank(provider, 200) || !nonBlank(subject, 200)) return null;
    return this.single('findExternal', async () => {
      const row = await this.dataSource
        .getRepository(ExternalIdentityEntity)
        .findOneBy({ provider, subject });
      return row ? toExternal(row) : null;
    });
  }

  public async createExternalIdentity(
    identity: Identity,
    external: ExternalIdentity,
  ): Promise<ExternalIdentity> {
    if (
      !nonBlank(identity.id, 64) ||
      !nonBlank(external.id, 64) ||
      !nonBlank(external.provider, 200) ||
      !nonBlank(external.subject, 200) ||
      external.identityId !== identity.id ||
      !isDate(identity.createdAt) ||
      !isDate(external.createdAt)
    )
      return invalid();
    try {
      await this.transaction('createExternalIdentity', async (manager) => {
        await manager.getRepository(IdentityEntity).insert({
          id: identity.id,
          status: identity.status,
          mfa: identity.mfa,
          authorizationVersion: identity.authorizationVersion,
          createdAt: identity.createdAt,
        });
        await manager.getRepository(ExternalIdentityEntity).insert({
          id: external.id,
          provider: external.provider,
          subject: external.subject,
          identityId: external.identityId,
          status: external.status,
          createdAt: external.createdAt,
        });
      });
      return external;
    } catch (error) {
      // A concurrent creator of the same provider+subject won: its link is the answer.
      // (The duplicate rolled back our identity row, so no orphan identity remains.)
      if (!(error instanceof AuthError) || error.code !== 'conflict') throw error;
      const winner = await this.findExternal(external.provider, external.subject);
      if (!winner) throw error;
      return winner;
    }
  }

  // ---- memberships --------------------------------------------------------------------------

  public async findMembership(tenantId: string, identityId: string): Promise<Membership | null> {
    if (!nonBlank(tenantId, 64) || !nonBlank(identityId, 64)) return null;
    return this.single('findMembership', async () => {
      const row = await this.dataSource
        .getRepository(MembershipEntity)
        .findOneBy({ tenantId, identityId });
      return row ? toMembership(row) : null;
    });
  }

  /** Role of an active membership of this tenant, or null (never reads another tenant's rows). */
  public async findRole(tenantId: string, identityId: string): Promise<string | null> {
    if (!nonBlank(tenantId, 64) || !nonBlank(identityId, 64)) return null;
    return this.single('findRole', async () => {
      const row = await this.dataSource
        .getRepository(MembershipEntity)
        .findOneBy({ tenantId, identityId, status: 'active' });
      return row ? row.role : null;
    });
  }

  public async countActiveAdmins(tenantId: string): Promise<number> {
    if (!nonBlank(tenantId, 64)) return 0;
    return this.single('countActiveAdmins', () =>
      this.dataSource
        .getRepository(MembershipEntity)
        .count({ where: { tenantId, role: ADMIN_ROLE, status: 'active' } }),
    );
  }

  /**
   * Changes the role of a pending or active membership of the tenant. Demoting the last active
   * administrator is refused (`LastAdministratorError`). An active membership's role change bumps
   * the identity's authorization version so existing sessions stop working. Returns false when the
   * membership does not exist or is revoked.
   */
  public async setRole(tenantId: string, identityId: string, role: string): Promise<boolean> {
    if (!nonBlank(tenantId, 64) || !nonBlank(identityId, 64) || !isRoleName(role)) return invalid();
    const known = await this.findMembership(tenantId, identityId);
    if (!known || known.status === 'revoked') return false;
    await this.ensureTenantLock('setRole', tenantId);
    return this.transaction('setRole', async (manager) => {
      await this.lockTenant(manager, tenantId);
      const identities = manager.getRepository(IdentityEntity);
      const memberships = manager.getRepository(MembershipEntity);
      if (!(await identities.findOne({ where: { id: identityId }, lock }))) return false;
      const current = await memberships.findOne({ where: { tenantId, identityId }, lock });
      if (!current || current.status === 'revoked') return false;
      if (current.role === role) return true;
      if (current.status === 'active' && current.role === ADMIN_ROLE && role !== ADMIN_ROLE)
        await this.assertAnotherAdmin(manager, tenantId);
      await memberships.update({ tenantId, identityId }, { role });
      if (current.status === 'active')
        await identities.increment({ id: identityId }, 'authorizationVersion', 1);
      return true;
    });
  }

  /** Port method: a plain invitation grants the least-privilege default role. */
  public createInvitation(
    identity: Identity,
    membership: Membership,
    invitation: Invitation,
    supersededAt: Date = this.now(),
  ): Promise<void> {
    return this.writeInvitation(identity, membership, invitation, supersededAt, undefined);
  }

  /** Same as `createInvitation`, but the pending membership is created (or re-issued) with `role`. */
  public createInvitationWithRole(
    identity: Identity,
    membership: Membership,
    invitation: Invitation,
    role: string,
    supersededAt: Date = this.now(),
  ): Promise<void> {
    if (!isRoleName(role)) return Promise.reject(new AuthError('invalid_input'));
    return this.writeInvitation(identity, membership, invitation, supersededAt, role);
  }

  private async writeInvitation(
    identity: Identity,
    membership: Membership,
    invitation: Invitation,
    supersededAt: Date,
    role: string | undefined,
  ): Promise<void> {
    if (
      !nonBlank(identity.id, 64) ||
      !nonBlank(membership.tenantId, 64) ||
      !nonBlank(membership.id, 64) ||
      !nonBlank(invitation.id, 64) ||
      membership.identityId !== identity.id ||
      invitation.identityId !== identity.id ||
      membership.tenantId !== invitation.tenantId ||
      !HASH_PATTERN.test(invitation.tokenHash) ||
      !isDate(invitation.expiresAt) ||
      !isDate(supersededAt) ||
      !isDate(membership.createdAt) ||
      !isDate(identity.createdAt)
    )
      return invalid();
    const tenantId = membership.tenantId;
    await this.transaction('createInvitation', async (manager) => {
      const identities = manager.getRepository(IdentityEntity);
      const memberships = manager.getRepository(MembershipEntity);
      const existingIdentity = await identities.findOne({ where: { id: identity.id }, lock });
      if (existingIdentity?.status === 'revoked') throw new AuthError('conflict');
      if (!existingIdentity)
        await identities.insert({
          id: identity.id,
          status: identity.status,
          mfa: identity.mfa,
          authorizationVersion: identity.authorizationVersion,
          createdAt: identity.createdAt,
        });
      const current = await memberships.findOne({
        where: { tenantId, identityId: identity.id },
        lock,
      });
      if (current?.status === 'active') throw new AuthError('conflict');
      if (!current)
        await memberships.insert({
          tenantId,
          identityId: identity.id,
          id: membership.id,
          role: role ?? DEFAULT_ROLE,
          status: 'pending',
          createdAt: membership.createdAt,
          activatedAt: null,
        });
      else if (current.status === 'revoked')
        await memberships.update(
          { tenantId, identityId: identity.id },
          {
            id: membership.id,
            role: role ?? DEFAULT_ROLE,
            status: 'pending',
            createdAt: membership.createdAt,
            activatedAt: null,
          },
        );
      else if (role !== undefined && current.role !== role)
        await memberships.update({ tenantId, identityId: identity.id }, { role });
      // A newer invitation supersedes earlier unconsumed links of the same tenant and identity.
      await manager
        .getRepository(InvitationEntity)
        .update(
          { tenantId, identityId: identity.id, consumedAt: IsNull() },
          { consumedAt: supersededAt },
        );
      await manager.getRepository(InvitationEntity).insert({
        id: invitation.id,
        tenantId,
        identityId: identity.id,
        tokenHash: invitation.tokenHash,
        expiresAt: invitation.expiresAt,
        consumedAt: invitation.consumedAt,
      });
    });
  }

  public async activateInvitation(
    tokenHash: string,
    provider: string,
    subject: string,
    activatedAt: Date,
  ): Promise<InvitationActivation | null> {
    if (
      !HASH_PATTERN.test(tokenHash) ||
      !nonBlank(provider, 200) ||
      !nonBlank(subject, 200) ||
      !isDate(activatedAt)
    )
      return null;
    try {
      return await this.transaction('activateInvitation', async (manager) => {
        const invitation = await manager.getRepository(InvitationEntity).findOneBy({ tokenHash });
        if (!invitation || invitation.consumedAt || invitation.expiresAt <= activatedAt)
          throw new ActivationRejected();
        const { tenantId, identityId } = invitation;
        const identities = manager.getRepository(IdentityEntity);
        const memberships = manager.getRepository(MembershipEntity);
        const externals = manager.getRepository(ExternalIdentityEntity);
        // Serialize concurrent activations of one identity (row lock), then re-validate under the lock.
        const identity = await identities.findOne({ where: { id: identityId }, lock });
        const membership = await memberships.findOne({ where: { tenantId, identityId }, lock });
        const linked = await externals.findOneBy({ provider, subject });
        const identityLink = await externals.findOneBy({ identityId });
        if (
          !identity ||
          identity.status === 'revoked' ||
          !membership ||
          membership.status !== 'pending' ||
          (linked !== null && linked.identityId !== identity.id) ||
          (identityLink !== null && identityLink.id !== linked?.id) ||
          (identityLink === null && identity.status !== 'pending')
        )
          throw new ActivationRejected();
        if (!linked) {
          try {
            await externals.insert({
              id: randomUUID(),
              provider,
              subject,
              identityId: identity.id,
              status: 'active',
              createdAt: activatedAt,
            });
          } catch (error) {
            // A concurrent winner linked this subject (or this identity) first.
            if (isDuplicateKey(error)) throw new ActivationRejected();
            throw error;
          }
        }
        await identities.update({ id: identity.id }, { status: 'active' });
        await memberships.update({ tenantId, identityId }, { status: 'active', activatedAt });
        const consumed = await manager
          .getRepository(InvitationEntity)
          .update(
            { id: invitation.id, consumedAt: IsNull(), expiresAt: MoreThan(activatedAt) },
            { consumedAt: activatedAt },
          );
        if (consumed.affected !== 1) throw new ActivationRejected();
        return {
          identity: { ...toIdentity(identity), status: 'active' },
          membership: { ...toMembership(membership), status: 'active', activatedAt },
        } satisfies InvitationActivation;
      });
    } catch (error) {
      if (error instanceof ActivationRejected) return null;
      throw error;
    }
  }

  /**
   * Revokes the membership and bumps the identity's authorization version in one transaction. The
   * tenant's final active administrator cannot be revoked (`LastAdministratorError`): the check runs
   * under the tenant lock row, so concurrent removals in any process serialize. The membership's
   * sessions are also marked revoked, and any unconsumed invitation of the membership is consumed (revoking a
   * pending invitation). Returns false when the membership is missing or already revoked.
   */
  public async revokeMembership(tenantId: string, identityId: string): Promise<boolean> {
    if (!nonBlank(tenantId, 64) || !nonBlank(identityId, 64)) return false;
    // No lock rows are created for unknown tenants: only an existing membership proves the tenant.
    const known = await this.findMembership(tenantId, identityId);
    if (!known || known.status === 'revoked') return false;
    await this.ensureTenantLock('revokeMembership', tenantId);
    return this.transaction('revokeMembership', async (manager) => {
      await this.lockTenant(manager, tenantId);
      const identities = manager.getRepository(IdentityEntity);
      const memberships = manager.getRepository(MembershipEntity);
      if (!(await identities.findOne({ where: { id: identityId }, lock }))) return false;
      const current = await memberships.findOne({ where: { tenantId, identityId }, lock });
      if (!current || current.status === 'revoked') return false;
      if (current.status === 'active' && current.role === ADMIN_ROLE)
        await this.assertAnotherAdmin(manager, tenantId);
      await memberships.update({ tenantId, identityId }, { status: 'revoked' });
      // Revoking a pending membership also consumes its invitation links (single use, never redeemable again).
      await manager
        .getRepository(InvitationEntity)
        .update({ tenantId, identityId, consumedAt: IsNull() }, { consumedAt: this.now() });
      await manager
        .getRepository(SessionEntity)
        .update({ tenantId, identityId, revokedAt: IsNull() }, { revokedAt: this.now() });
      await identities.increment({ id: identityId }, 'authorizationVersion', 1);
      return true;
    });
  }

  // ---- custom roles -------------------------------------------------------------------------

  /**
   * Custom roles of the tenant, oldest first. Roles are immutable and their permission rows commit
   * with them; reading roles before permissions therefore never shows a role without its permissions.
   */
  public async listCustomRoles(tenantId: string): Promise<readonly CustomRoleRecord[]> {
    if (!nonBlank(tenantId, 64)) return [];
    return this.single('listCustomRoles', async () => {
      const roles = await this.dataSource.getRepository(RoleEntity).find({ where: { tenantId } });
      const permissions = await this.dataSource
        .getRepository(RolePermissionEntity)
        .find({ where: { tenantId } });
      return [...roles]
        .sort(
          (left, right) =>
            left.createdAt.getTime() - right.createdAt.getTime() || (left.id < right.id ? -1 : 1),
        )
        .map((role) => toCustomRole(role, permissions));
    });
  }

  /** One custom role of this tenant; another tenant's role id answers null, like an unknown one. */
  public async findCustomRole(tenantId: string, roleId: string): Promise<CustomRoleRecord | null> {
    if (!nonBlank(tenantId, 64) || !nonBlank(roleId, 64)) return null;
    return this.single('findCustomRole', async () => {
      const role = await this.dataSource
        .getRepository(RoleEntity)
        .findOneBy({ tenantId, id: roleId });
      if (!role) return null;
      const permissions = await this.dataSource
        .getRepository(RolePermissionEntity)
        .find({ where: { tenantId, roleId } });
      return toCustomRole(role, permissions);
    });
  }

  /**
   * Stores a custom role of the tenant. The name check and the per-tenant limit run under the
   * tenant lock row (the same one that serializes administrator changes), so concurrent creations in
   * any process can neither duplicate a name (case-insensitive) nor exceed `maxRoles`. Only a tenant
   * that already has memberships can hold roles. The role and its permissions commit together.
   */
  public async createCustomRole(
    tenantId: string,
    role: CustomRoleRecord,
    maxRoles: number,
  ): Promise<CreateCustomRoleOutcome> {
    const name = typeof role.name === 'string' ? role.name.trim() : '';
    if (
      !nonBlank(tenantId, 64) ||
      typeof role.id !== 'string' ||
      !ROLE_ID_PATTERN.test(role.id) ||
      !nonBlank(name, CUSTOM_ROLE_LIMITS.nameLength) ||
      !Array.isArray(role.permissions) ||
      role.permissions.length > CUSTOM_ROLE_LIMITS.permissions ||
      new Set(role.permissions).size !== role.permissions.length ||
      !role.permissions.every(
        (permission) => typeof permission === 'string' && PERMISSION_PATTERN.test(permission),
      ) ||
      !Number.isSafeInteger(maxRoles) ||
      maxRoles < 1
    )
      return invalid();
    // Only an existing membership proves the tenant: no lock rows are created for unknown tenants.
    const known = await this.single('createCustomRole', () =>
      this.dataSource.getRepository(MembershipEntity).count({ where: { tenantId } }),
    );
    if (known === 0) throw new AuthError('not_found');
    await this.ensureTenantLock('createCustomRole', tenantId);
    const nameKey = name.toLowerCase();
    return this.transaction('createCustomRole', async (manager) => {
      await this.lockTenant(manager, tenantId);
      const roles = manager.getRepository(RoleEntity);
      const existing = await roles.find({ where: { tenantId } });
      if (existing.length >= maxRoles) return 'limit_reached' as const;
      if (existing.some((candidate) => candidate.nameKey === nameKey)) return 'name_taken' as const;
      await roles.insert({ tenantId, id: role.id, name, nameKey, createdAt: this.now() });
      const permissions = manager.getRepository(RolePermissionEntity);
      for (const [position, permission] of role.permissions.entries())
        await permissions.insert({ tenantId, roleId: role.id, permission, position });
      return 'created' as const;
    });
  }

  // ---- recovery -----------------------------------------------------------------------------

  public async findRecovery(tokenHash: string): Promise<RecoveryRequest | null> {
    if (!HASH_PATTERN.test(tokenHash)) return null;
    return this.single('findRecovery', async () => {
      const row = await this.dataSource.getRepository(RecoveryEntity).findOneBy({ tokenHash });
      return row ? toRecovery(row) : null;
    });
  }

  public async saveRecovery(request: RecoveryRequest): Promise<void> {
    if (
      !nonBlank(request.id, 64) ||
      !nonBlank(request.identityId, 64) ||
      !HASH_PATTERN.test(request.tokenHash) ||
      !isDate(request.issuedAt) ||
      !isDate(request.expiresAt)
    )
      return invalid();
    await this.transaction('saveRecovery', async (manager) => {
      // The identity row lock serializes concurrent requests of one identity.
      const identity = await manager
        .getRepository(IdentityEntity)
        .findOne({ where: { id: request.identityId }, lock });
      if (!identity) throw new AuthError('not_found');
      const recoveries = manager.getRepository(RecoveryEntity);
      await recoveries.update(
        { identityId: request.identityId, usedAt: IsNull(), supersededAt: IsNull() },
        { supersededAt: request.issuedAt },
      );
      await recoveries.insert({
        id: request.id,
        identityId: request.identityId,
        tokenHash: request.tokenHash,
        issuedAt: request.issuedAt,
        expiresAt: request.expiresAt,
        usedAt: request.usedAt,
        supersededAt: request.supersededAt ?? null,
      });
    });
  }

  public async consumeRecovery(id: string, usedAt: Date): Promise<boolean> {
    if (!nonBlank(id, 64) || !isDate(usedAt)) return false;
    return this.transaction('consumeRecovery', async (manager) => {
      const recoveries = manager.getRepository(RecoveryEntity);
      const request = await recoveries.findOneBy({ id });
      if (!request) return false;
      const identities = manager.getRepository(IdentityEntity);
      await identities.findOne({ where: { id: request.identityId }, lock });
      const consumed = await recoveries.update(
        { id, usedAt: IsNull(), supersededAt: IsNull(), expiresAt: MoreThan(usedAt) },
        { usedAt },
      );
      if (consumed.affected !== 1) return false;
      await identities.increment({ id: request.identityId }, 'authorizationVersion', 1);
      return true;
    });
  }

  // ---- sessions -----------------------------------------------------------------------------

  public async saveSession(session: Session): Promise<void> {
    if (
      !nonBlank(session.id, 64) ||
      !nonBlank(session.identityId, 64) ||
      !nonBlank(session.tenantId, 64) ||
      !HASH_PATTERN.test(session.tokenHash) ||
      !isDate(session.createdAt) ||
      !isDate(session.lastSeenAt) ||
      !isDate(session.expiresAt) ||
      !Number.isSafeInteger(session.authorizationVersion) ||
      session.authorizationVersion < 1
    )
      return invalid();
    await this.single('saveSession', async () => {
      try {
        await this.dataSource.getRepository(SessionEntity).insert({
          id: session.id,
          identityId: session.identityId,
          tenantId: session.tenantId,
          tokenHash: session.tokenHash,
          createdAt: session.createdAt,
          lastSeenAt: session.lastSeenAt,
          expiresAt: session.expiresAt,
          revokedAt: session.revokedAt,
          authorizationVersion: session.authorizationVersion,
        });
      } catch (error) {
        // A session needs a membership row of its own tenant (composite foreign key).
        if (isMissingParent(error)) throw new AuthError('unauthorized');
        throw error;
      }
    });
  }

  public async findSession(tokenHash: string): Promise<Session | null> {
    if (!HASH_PATTERN.test(tokenHash)) return null;
    return this.single('findSession', async () => {
      const row = await this.dataSource.getRepository(SessionEntity).findOneBy({ tokenHash });
      return row ? toSession(row) : null;
    });
  }

  public async revokeSession(id: string, revokedAt: Date): Promise<boolean> {
    if (!nonBlank(id, 64) || !isDate(revokedAt)) return false;
    return this.single('revokeSession', async () => {
      const result = await this.dataSource
        .getRepository(SessionEntity)
        .update({ id, revokedAt: IsNull() }, { revokedAt });
      return result.affected === 1;
    });
  }

  // ---- retention ----------------------------------------------------------------------------

  /** Deletes sessions, invitations and recovery requests that expired before `before`. */
  public async purgeExpired(
    before: Date,
  ): Promise<{ sessions: number; invitations: number; recoveries: number }> {
    if (!isDate(before)) return invalid();
    return this.transaction('purgeExpired', async (manager) => {
      const criteria = { expiresAt: LessThan(before) };
      const sessions = await manager.getRepository(SessionEntity).delete(criteria);
      const invitations = await manager.getRepository(InvitationEntity).delete(criteria);
      const recoveries = await manager.getRepository(RecoveryEntity).delete(criteria);
      return {
        sessions: sessions.affected ?? 0,
        invitations: invitations.affected ?? 0,
        recoveries: recoveries.affected ?? 0,
      };
    });
  }
}
