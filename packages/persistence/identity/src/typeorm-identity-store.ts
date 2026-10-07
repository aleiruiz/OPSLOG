import 'reflect-metadata';
import type { DataSource } from 'typeorm';
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
import { createExternalIdentity, findExternal, findIdentity } from './identity-ops.js';
import {
  activateInvitation,
  countActiveAdmins,
  findMembership,
  findRole,
  revokeMembership,
  setRole,
  writeInvitation,
} from './membership-ops.js';
import { createCustomRole, findCustomRole, listCustomRoles } from './role-ops.js';
import { isRoleName } from './role-model.js';
import type { CreateCustomRoleOutcome, CustomRoleRecord } from './role-model.js';
import {
  consumeRecovery,
  findRecovery,
  findSession,
  purgeExpired,
  revokeSession,
  saveRecovery,
  saveSession,
} from './session-ops.js';
import { IdentityStoreCore } from './store-core.js';
import type { TypeOrmIdentityStoreOptions } from './store-types.js';

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
  private readonly core: IdentityStoreCore;

  public constructor(dataSource: DataSource, options: TypeOrmIdentityStoreOptions = {}) {
    if (dataSource.options.type !== 'mysql' || dataSource.options.synchronize === true)
      throw new Error('Identity store requires MySQL with synchronize disabled');
    const username = dataSource.options.username;
    if (typeof username !== 'string' || !IDENTITY_RUNTIME_ACCOUNT.test(username))
      throw new Error('Identity store requires its restricted runtime account');
    this.core = new IdentityStoreCore(
      dataSource,
      options.now ?? (() => new Date()),
      Math.max(1, options.maxAttempts ?? 3),
      options.onError,
    );
  }

  // ---- identities ---------------------------------------------------------------------------

  public findIdentity(id: string): Promise<Identity | null> {
    return findIdentity(this.core, id);
  }

  public findExternal(provider: string, subject: string): Promise<ExternalIdentity | null> {
    return findExternal(this.core, provider, subject);
  }

  public createExternalIdentity(
    identity: Identity,
    external: ExternalIdentity,
  ): Promise<ExternalIdentity> {
    return createExternalIdentity(this.core, identity, external);
  }

  // ---- memberships --------------------------------------------------------------------------

  public findMembership(tenantId: string, identityId: string): Promise<Membership | null> {
    return findMembership(this.core, tenantId, identityId);
  }

  /** Role of an active membership of this tenant, or null (never reads another tenant's rows). */
  public findRole(tenantId: string, identityId: string): Promise<string | null> {
    return findRole(this.core, tenantId, identityId);
  }

  public countActiveAdmins(tenantId: string): Promise<number> {
    return countActiveAdmins(this.core, tenantId);
  }

  /** See `setRole` in membership-ops.ts: refuses demoting the last administrator. */
  public setRole(tenantId: string, identityId: string, role: string): Promise<boolean> {
    return setRole(this.core, tenantId, identityId, role);
  }

  /** Port method: a plain invitation grants the least-privilege default role. */
  public createInvitation(
    identity: Identity,
    membership: Membership,
    invitation: Invitation,
    supersededAt: Date = this.core.now(),
  ): Promise<void> {
    return writeInvitation(this.core, identity, membership, invitation, supersededAt, undefined);
  }

  /** Same as `createInvitation`, but the pending membership is created (or re-issued) with `role`. */
  public createInvitationWithRole(
    identity: Identity,
    membership: Membership,
    invitation: Invitation,
    role: string,
    supersededAt: Date = this.core.now(),
  ): Promise<void> {
    if (!isRoleName(role)) return Promise.reject(new AuthError('invalid_input'));
    return writeInvitation(this.core, identity, membership, invitation, supersededAt, role);
  }

  public activateInvitation(
    tokenHash: string,
    provider: string,
    subject: string,
    activatedAt: Date,
  ): Promise<InvitationActivation | null> {
    return activateInvitation(this.core, tokenHash, provider, subject, activatedAt);
  }

  /** See `revokeMembership` in membership-ops.ts: the final active administrator cannot be revoked. */
  public revokeMembership(tenantId: string, identityId: string): Promise<boolean> {
    return revokeMembership(this.core, tenantId, identityId);
  }

  // ---- custom roles -------------------------------------------------------------------------

  /**
   * Custom roles of the tenant, oldest first. Roles are immutable and their permission rows commit
   * with them; reading roles before permissions therefore never shows a role without its permissions.
   */
  public listCustomRoles(tenantId: string): Promise<readonly CustomRoleRecord[]> {
    return listCustomRoles(this.core, tenantId);
  }

  /** One custom role of this tenant; another tenant's role id answers null, like an unknown one. */
  public findCustomRole(tenantId: string, roleId: string): Promise<CustomRoleRecord | null> {
    return findCustomRole(this.core, tenantId, roleId);
  }

  /**
   * Stores a custom role of the tenant. The name check and the per-tenant limit run under the
   * tenant lock row (the same one that serializes administrator changes), so concurrent creations in
   * any process can neither duplicate a name (case-insensitive) nor exceed `maxRoles`. Only a tenant
   * that already has memberships can hold roles. The role and its permissions commit together.
   */
  public createCustomRole(
    tenantId: string,
    role: CustomRoleRecord,
    maxRoles: number,
  ): Promise<CreateCustomRoleOutcome> {
    return createCustomRole(this.core, tenantId, role, maxRoles);
  }

  // ---- recovery -----------------------------------------------------------------------------

  public findRecovery(tokenHash: string): Promise<RecoveryRequest | null> {
    return findRecovery(this.core, tokenHash);
  }

  public saveRecovery(request: RecoveryRequest): Promise<void> {
    return saveRecovery(this.core, request);
  }

  public consumeRecovery(id: string, usedAt: Date): Promise<boolean> {
    return consumeRecovery(this.core, id, usedAt);
  }

  // ---- sessions -----------------------------------------------------------------------------

  public saveSession(session: Session): Promise<void> {
    return saveSession(this.core, session);
  }

  public findSession(tokenHash: string): Promise<Session | null> {
    return findSession(this.core, tokenHash);
  }

  public revokeSession(id: string, revokedAt: Date): Promise<boolean> {
    return revokeSession(this.core, id, revokedAt);
  }

  // ---- retention ----------------------------------------------------------------------------

  /** Deletes sessions, invitations and recovery requests that expired before `before`. */
  public purgeExpired(
    before: Date,
  ): Promise<{ sessions: number; invitations: number; recoveries: number }> {
    return purgeExpired(this.core, before);
  }
}
