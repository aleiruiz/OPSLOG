import { createHash, randomBytes } from 'node:crypto';
import {
  type ExternalIdentity,
  type Identity,
  type Invitation,
  type InvitationActivation,
  type Membership,
  type Permission,
  type RecoveryRequest,
  type Session,
  type TenantContext,
} from './types.js';

/** Resolves tenant membership and effective permissions from trusted server-side state. */
export interface IdentityAccessResolver {
  resolveActiveTenant(identityId: string): Promise<string | null>;
  resolvePermissions(context: TenantContext): Promise<readonly Permission[]>;
}

/** Minimal sanitized audit envelope used to atomically record identity mutations. */
export interface IdentityMutationAudit {
  readonly eventId: string;
  readonly tenantId: string;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly occurredAt: string;
  readonly actor: { readonly id: string; readonly kind: 'user' | 'system' };
  readonly correlationId: string;
  readonly data: Readonly<Record<string, unknown>>;
}

/** Builds an activation audit event from the invitation row locked inside the transaction. */
export type InvitationActivationAudit = (activation: InvitationActivation) => IdentityMutationAudit;

export interface IdentityStore {
  /** True only when audit rows can be committed in the same transaction as identity mutations. */
  readonly supportsAtomicAudit?: boolean;
  /** Atomically persist a new identity and its provider+subject key. Enforce a unique constraint on that key and return the winner on conflict. */
  createExternalIdentity(identity: Identity, external: ExternalIdentity): Promise<ExternalIdentity>;
  findIdentity(id: string): Promise<Identity | null>;
  findExternal(provider: string, subject: string): Promise<ExternalIdentity | null>;
  findMembership(tenantId: string, identityId: string): Promise<Membership | null>;
  /**
   * Atomically create the invitation and pending identity/membership, preserving existing non-revoked identities.
   * Earlier unconsumed invitations for the same tenant and identity must be superseded (marked consumed) in the same
   * transaction so a leaked older link cannot activate the account after a reissue.
   */
  createInvitation(
    identity: Identity,
    membership: Membership,
    invitation: Invitation,
    supersededAt?: Date,
  ): Promise<void>;
  /** Persistent adapters may atomically store invitation, role, local audit and pending delivery. */
  createInvitationWithRoleAndAudit?(
    identity: Identity,
    membership: Membership,
    invitation: Invitation,
    role: string,
    audit: IdentityMutationAudit,
    supersededAt?: Date,
  ): Promise<void>;
  /**
   * Atomically consume the unexpired invitation, bind the verified subject, and activate identity plus membership.
   * An identity that already has an external link, or is not pending, may only be activated by that same
   * provider+subject; a different subject must be rejected (returns null) so a leaked token cannot take over an account.
   * Concurrent activations of one pending identity must serialize: lock the identity row (`SELECT ... FOR UPDATE`) or
   * enforce a UNIQUE constraint on the external link's identity id, otherwise two subjects could both bind to it.
   */
  activateInvitation(
    tokenHash: string,
    provider: string,
    subject: string,
    activatedAt: Date,
  ): Promise<InvitationActivation | null>;
  activateInvitationWithAudit?(
    tokenHash: string,
    provider: string,
    subject: string,
    activatedAt: Date,
    audit: IdentityMutationAudit | InvitationActivationAudit,
  ): Promise<InvitationActivation | null>;
  findRecovery(tokenHash: string): Promise<RecoveryRequest | null>;
  /** Persist the request and mark older unused requests of the same identity as superseded (`supersededAt = request.issuedAt`). */
  saveRecovery(request: RecoveryRequest): Promise<void>;
  /**
   * One transaction: consume the request only when `used_at IS NULL AND superseded_at IS NULL AND expires_at > :usedAt`,
   * and in the same transaction bump the identity authorizationVersion so every existing session is invalidated.
   * Returns false when the conditional update matches no row.
   */
  consumeRecovery(id: string, usedAt: Date): Promise<boolean>;
  /**
   * One transaction: mark the membership revoked and bump the identity authorizationVersion. Revoking a pending
   * membership revokes its invitation: the token can no longer be redeemed (activation requires a pending
   * membership) and persistent adapters also mark its unconsumed invitation rows consumed. Returns false when the membership does not exist or is already revoked.
   * authorizationVersion is per identity, so this also ends the identity's sessions in other tenants (safe but
   * broad). SPECS §5.3's "last active administrator" rule is not enforced here: the caller or the persistent
   * adapter must refuse to revoke the final administrator of a tenant.
   */
  revokeMembership(tenantId: string, identityId: string): Promise<boolean>;
  revokeMembershipWithAudit?(
    tenantId: string,
    identityId: string,
    audit: IdentityMutationAudit,
  ): Promise<boolean>;
  /** Persistent adapters may atomically store a role change and its local audit/delivery rows. */
  setRoleWithAudit?(
    tenantId: string,
    identityId: string,
    role: string,
    audit: IdentityMutationAudit,
  ): Promise<boolean>;
  saveSession(session: Session): Promise<void>;
  findSession(tokenHash: string): Promise<Session | null>;
  revokeSession(id: string, revokedAt: Date): Promise<boolean>;
}

/** Delivers recovery links through a verified, out-of-band destination owned by the identity. */
export interface RecoveryNotifier {
  deliver(identityId: string, token: string, expiresAt: Date): Promise<void>;
}

export interface TokenGenerator {
  create(): string;
  hash(token: string): string;
}

export const opaqueTokenGenerator: TokenGenerator = {
  create: () => randomBytes(32).toString('base64url'),
  hash: (token) => createHash('sha256').update(token, 'utf8').digest('hex'),
};
