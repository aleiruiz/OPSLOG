import { randomUUID, timingSafeEqual } from 'node:crypto';
import { AuthError } from './errors.js';
import { type IdentityStore } from './ports.js';
import {
  type ExternalIdentity,
  type Identity,
  type Invitation,
  type InvitationActivation,
  type Membership,
  type RecoveryRequest,
  type Session,
} from './types.js';

const sameSecret = (left: string, right: string): boolean => {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
};

export class InMemoryIdentityStore implements IdentityStore {
  private readonly identities = new Map<string, Identity>();
  private readonly external = new Map<string, ExternalIdentity>();
  private readonly invitations = new Map<string, Invitation>();
  private readonly memberships = new Map<string, Membership>();
  private readonly recoveries = new Map<string, RecoveryRequest>();
  private readonly sessions = new Map<string, Session>();
  public async findIdentity(id: string) {
    return this.identities.get(id) ?? null;
  }
  public async findExternal(provider: string, subject: string) {
    return this.external.get(`${provider}\u0000${subject}`) ?? null;
  }
  public async createExternalIdentity(identity: Identity, external: ExternalIdentity) {
    const key = `${external.provider}\u0000${external.subject}`;
    const winner = this.external.get(key);
    if (winner) return winner;
    this.identities.set(identity.id, identity);
    this.external.set(key, external);
    return external;
  }
  public async findMembership(tenantId: string, identityId: string) {
    return this.memberships.get(`${tenantId}\u0000${identityId}`) ?? null;
  }
  public async createInvitation(
    identity: Identity,
    membership: Membership,
    invitation: Invitation,
    supersededAt: Date = new Date(),
  ) {
    if (
      membership.identityId !== identity.id ||
      invitation.identityId !== identity.id ||
      membership.tenantId !== invitation.tenantId
    )
      throw new AuthError('invalid_input');
    const currentIdentity = this.identities.get(identity.id);
    if (currentIdentity?.status === 'revoked') throw new AuthError('conflict');
    if (!currentIdentity) this.identities.set(identity.id, identity);
    const membershipKey = `${membership.tenantId}\u0000${membership.identityId}`;
    const currentMembership = this.memberships.get(membershipKey);
    if (currentMembership?.status === 'active') throw new AuthError('conflict');
    if (currentMembership?.status !== 'pending') this.memberships.set(membershipKey, membership);
    // A newer invitation supersedes earlier unconsumed links for the same tenant and identity.
    for (const [id, previous] of this.invitations)
      if (
        previous.tenantId === invitation.tenantId &&
        previous.identityId === invitation.identityId &&
        !previous.consumedAt
      )
        this.invitations.set(id, { ...previous, consumedAt: supersededAt });
    this.invitations.set(invitation.id, invitation);
  }
  public async activateInvitation(
    tokenHash: string,
    provider: string,
    subject: string,
    activatedAt: Date,
  ): Promise<InvitationActivation | null> {
    const invitation =
      [...this.invitations.values()].find((item) => sameSecret(item.tokenHash, tokenHash)) ?? null;
    if (!invitation || invitation.consumedAt || invitation.expiresAt <= activatedAt) return null;
    const identity = this.identities.get(invitation.identityId);
    const membershipKey = `${invitation.tenantId}\u0000${invitation.identityId}`;
    const membership = this.memberships.get(membershipKey);
    const externalKey = `${provider}\u0000${subject}`;
    const linked = this.external.get(externalKey);
    const identityLink = identity
      ? [...this.external.values()].find((item) => item.identityId === identity.id)
      : undefined;
    if (
      !identity ||
      identity.status === 'revoked' ||
      !membership ||
      membership.status !== 'pending' ||
      (linked !== undefined && linked.identityId !== identity.id) ||
      (identityLink !== undefined && identityLink !== linked) ||
      (identityLink === undefined && identity.status !== 'pending')
    )
      return null;
    const activatedIdentity: Identity = { ...identity, status: 'active' };
    const activatedMembership: Membership = {
      ...membership,
      status: 'active',
      activatedAt,
    };
    if (!linked)
      this.external.set(externalKey, {
        id: randomUUID(),
        provider,
        subject,
        identityId: identity.id,
        status: 'active',
        createdAt: activatedAt,
      });
    this.identities.set(identity.id, activatedIdentity);
    this.memberships.set(membershipKey, activatedMembership);
    this.invitations.set(invitation.id, { ...invitation, consumedAt: activatedAt });
    return { identity: activatedIdentity, membership: activatedMembership };
  }
  public async findRecovery(tokenHash: string) {
    return (
      [...this.recoveries.values()].find((item) => sameSecret(item.tokenHash, tokenHash)) ?? null
    );
  }
  public async saveRecovery(request: RecoveryRequest) {
    for (const [id, item] of this.recoveries)
      if (item.identityId === request.identityId && !item.usedAt && !item.supersededAt)
        this.recoveries.set(id, { ...item, supersededAt: request.issuedAt });
    this.recoveries.set(request.id, request);
  }
  public async consumeRecovery(id: string, usedAt: Date) {
    const item = this.recoveries.get(id);
    if (!item || item.usedAt || item.supersededAt || item.expiresAt <= usedAt) return false;
    this.recoveries.set(id, { ...item, usedAt });
    this.bump(item.identityId);
    return true;
  }
  public async revokeMembership(tenantId: string, identityId: string) {
    const key = `${tenantId}\u0000${identityId}`;
    const item = this.memberships.get(key);
    if (!item || item.status === 'revoked') return false;
    this.memberships.set(key, { ...item, status: 'revoked' });
    this.bump(identityId);
    return true;
  }
  private bump(identityId: string): void {
    const item = this.identities.get(identityId);
    if (item)
      this.identities.set(identityId, {
        ...item,
        authorizationVersion: item.authorizationVersion + 1,
      });
  }
  public async saveSession(session: Session) {
    this.sessions.set(session.id, session);
  }
  public async findSession(tokenHash: string) {
    return (
      [...this.sessions.values()].find((item) => sameSecret(item.tokenHash, tokenHash)) ?? null
    );
  }
  public async revokeSession(id: string, revokedAt: Date) {
    const item = this.sessions.get(id);
    if (!item || item.revokedAt) return false;
    this.sessions.set(id, { ...item, revokedAt });
    return true;
  }
}
