import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export type IdentityStatus = 'pending' | 'active' | 'revoked';
export type MfaStatus = 'disabled' | 'optional' | 'required';
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
export interface ActorRef {
  readonly subject: string;
  readonly kind: 'user' | 'system';
}
export interface TenantContext {
  readonly tenantId: string;
  readonly actor: ActorRef;
  readonly authorizationVersion: number;
  readonly correlationId: string;
}
/** Resolves tenant membership and effective permissions from trusted server-side state. */
export interface IdentityAccessResolver {
  resolveActiveTenant(identityId: string): Promise<string | null>;
  resolvePermissions(context: TenantContext): Promise<readonly Permission[]>;
}
export interface ExternalIdentity {
  readonly id: string;
  readonly provider: string;
  readonly subject: string;
  readonly identityId: string;
  readonly status: IdentityStatus;
  readonly createdAt: Date;
}
export interface Identity {
  readonly id: string;
  readonly status: IdentityStatus;
  readonly mfa: MfaStatus;
  readonly authorizationVersion: number;
  readonly createdAt: Date;
}
export interface Invitation {
  readonly id: string;
  readonly tenantId: string;
  readonly identityId: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
}
export interface Membership {
  readonly id: string;
  readonly tenantId: string;
  readonly identityId: string;
  readonly status: 'pending' | 'active' | 'revoked';
  readonly createdAt: Date;
  readonly activatedAt: Date | null;
}
export interface InvitationActivation {
  readonly identity: Identity;
  readonly membership: Membership;
}
export interface RecoveryRequest {
  readonly id: string;
  readonly identityId: string;
  readonly tokenHash: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly usedAt: Date | null;
  readonly supersededAt?: Date | null;
}
export interface Session {
  readonly id: string;
  readonly identityId: string;
  readonly tenantId: string;
  readonly tokenHash: string;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly authorizationVersion: number;
}

export class AuthError extends Error {
  public constructor(
    public readonly code:
      | 'invalid_input'
      | 'unauthorized'
      | 'forbidden'
      | 'not_found'
      | 'conflict'
      | 'expired',
  ) {
    super(code === 'unauthorized' ? 'Authentication required' : 'Authentication request rejected');
    this.name = 'AuthError';
  }
}

export interface IdentityStore {
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

const nonEmpty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 200;
export interface IdentityServiceOptions {
  /** Minimum time between recovery deliveries for one identity; extra requests get the same public answer. */
  readonly recoveryMinIntervalMs?: number;
  /** Receives store/notifier failures of background recovery work (never contains the token). */
  readonly onBackgroundError?: (error: unknown) => void;
}
export class IdentityService {
  private readonly pending = new Set<Promise<void>>();
  private readonly lastRecovery = new Map<string, number>();
  private readonly recoveryMinIntervalMs: number;
  public constructor(
    private readonly store: IdentityStore,
    private readonly recoveryNotifier: RecoveryNotifier,
    private readonly tokens: TokenGenerator = opaqueTokenGenerator,
    private readonly now: () => Date = () => new Date(),
    private readonly options: IdentityServiceOptions = {},
  ) {
    this.recoveryMinIntervalMs = options.recoveryMinIntervalMs ?? 60_000;
  }
  /** Resolve an already-linked external subject. Never provisions: identities are created only by invitations. */
  public async resolveExternal(provider: string, subject: string): Promise<Identity> {
    if (!nonEmpty(provider) || !nonEmpty(subject)) throw new AuthError('invalid_input');
    const existing = await this.store.findExternal(provider, subject);
    if (!existing) throw new AuthError('unauthorized');
    const identity = await this.store.findIdentity(existing.identityId);
    if (!identity || identity.status !== 'active') throw new AuthError('unauthorized');
    return identity;
  }
  /** Bootstrap/administration only (e.g. first tenant owner); not reachable from AuthApi.login. */
  public async provisionExternal(provider: string, subject: string): Promise<Identity> {
    if (!nonEmpty(provider) || !nonEmpty(subject)) throw new AuthError('invalid_input');
    const existing = await this.store.findExternal(provider, subject);
    if (existing) {
      const identity = await this.store.findIdentity(existing.identityId);
      if (!identity || identity.status === 'revoked') throw new AuthError('unauthorized');
      return identity;
    }
    const identity: Identity = {
      id: randomUUID(),
      status: 'active',
      mfa: 'disabled',
      authorizationVersion: 1,
      createdAt: this.now(),
    };
    const externalIdentity: ExternalIdentity = {
      id: randomUUID(),
      provider,
      subject,
      identityId: identity.id,
      status: identity.status,
      createdAt: identity.createdAt,
    };
    const winner = await this.store.createExternalIdentity(identity, externalIdentity);
    const linkedIdentity = await this.store.findIdentity(winner.identityId);
    if (!linkedIdentity || linkedIdentity.status === 'revoked') throw new AuthError('unauthorized');
    return linkedIdentity;
  }
  public async issueInvitation(
    tenantId: string,
    identityId: string = randomUUID(),
    ttlMs = 72 * 60 * 60 * 1000,
  ) {
    if (!nonEmpty(tenantId) || !nonEmpty(identityId) || !Number.isFinite(ttlMs) || ttlMs <= 0)
      throw new AuthError('invalid_input');
    const currentIdentity = await this.store.findIdentity(identityId);
    if (currentIdentity?.status === 'revoked') throw new AuthError('conflict');
    const now = this.now();
    const identity: Identity = currentIdentity ?? {
      id: identityId,
      status: 'pending',
      mfa: 'disabled',
      authorizationVersion: 1,
      createdAt: now,
    };
    const membership: Membership = {
      id: randomUUID(),
      tenantId,
      identityId,
      status: 'pending',
      createdAt: now,
      activatedAt: null,
    };
    const token = this.tokens.create();
    const invitation: Invitation = {
      id: randomUUID(),
      tenantId,
      identityId,
      tokenHash: this.tokens.hash(token),
      expiresAt: new Date(now.getTime() + ttlMs),
      consumedAt: null,
    };
    await this.store.createInvitation(identity, membership, invitation, now);
    return { id: invitation.id, identityId, token, expiresAt: invitation.expiresAt } as const;
  }
  public async activateInvitation(
    token: string,
    provider: string,
    subject: string,
  ): Promise<InvitationActivation> {
    if (!nonEmpty(token) || !nonEmpty(provider) || !nonEmpty(subject))
      throw new AuthError('unauthorized');
    const result = await this.store.activateInvitation(
      this.tokens.hash(token),
      provider,
      subject,
      this.now(),
    );
    if (!result) throw new AuthError('unauthorized');
    return result;
  }
  public async requestRecovery(
    identityId: string,
    ttlMs = 60 * 60 * 1000,
  ): Promise<{ accepted: true }> {
    if (!nonEmpty(identityId) || !Number.isFinite(ttlMs) || ttlMs <= 0)
      throw new AuthError('invalid_input');
    // Existing and unknown identities run the same foreground path; all lookups and delivery
    // happen in the background so response time does not reveal whether the account exists.
    const work = this.deliverRecovery(identityId, ttlMs).catch((error: unknown) =>
      this.options.onBackgroundError?.(error),
    );
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work));
    return { accepted: true };
  }
  /** Resolves when background recovery deliveries have finished (tests, graceful shutdown). */
  public async settled(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }
  private async deliverRecovery(identityId: string, ttlMs: number): Promise<void> {
    const token = this.tokens.create();
    const identity = await this.store.findIdentity(identityId);
    if (identity?.status !== 'active') return;
    const issuedAt = this.now();
    const last = this.lastRecovery.get(identityId);
    if (last !== undefined && issuedAt.getTime() - last < this.recoveryMinIntervalMs) return;
    this.pruneRecoveryThrottle(issuedAt.getTime());
    // Reserve the slot before awaiting so concurrent requests cannot both pass, but release it when
    // saving or delivering fails so a transient error does not suppress the user's retry.
    this.lastRecovery.set(identityId, issuedAt.getTime());
    const expiresAt = new Date(issuedAt.getTime() + ttlMs);
    try {
      await this.store.saveRecovery({
        id: randomUUID(),
        identityId,
        tokenHash: this.tokens.hash(token),
        issuedAt,
        expiresAt,
        usedAt: null,
      });
      await this.recoveryNotifier.deliver(identity.id, token, expiresAt);
    } catch (error) {
      if (this.lastRecovery.get(identityId) === issuedAt.getTime()) {
        if (last === undefined) this.lastRecovery.delete(identityId);
        else this.lastRecovery.set(identityId, last);
      }
      throw error;
    }
  }
  private pruneRecoveryThrottle(nowMs: number): void {
    if (this.lastRecovery.size < 1000) return;
    for (const [id, at] of this.lastRecovery)
      if (nowMs - at >= this.recoveryMinIntervalMs) this.lastRecovery.delete(id);
  }
  public async consumeRecovery(token: string): Promise<Identity> {
    if (!nonEmpty(token)) throw new AuthError('invalid_input');
    const request = await this.store.findRecovery(this.tokens.hash(token));
    if (!request || request.usedAt || request.supersededAt || request.expiresAt <= this.now())
      throw new AuthError('unauthorized');
    if (!(await this.store.consumeRecovery(request.id, this.now())))
      throw new AuthError('conflict');
    const identity = await this.store.findIdentity(request.identityId);
    if (!identity || identity.status !== 'active') throw new AuthError('unauthorized');
    // The port bumped authorizationVersion in the same transaction (every session is now invalid).
    const refreshed = await this.store.findIdentity(identity.id);
    if (!refreshed) throw new AuthError('unauthorized');
    return refreshed;
  }
  /** Revoke a tenant membership and invalidate the identity's sessions. Callers must authorize `manage_users` first. */
  public async revokeMembership(tenantId: string, identityId: string): Promise<void> {
    if (!nonEmpty(tenantId) || !nonEmpty(identityId)) throw new AuthError('invalid_input');
    if (!(await this.store.revokeMembership(tenantId, identityId)))
      throw new AuthError('not_found');
  }
  public async createSession(identityId: string, tenantId: string, ttlMs = 8 * 60 * 60 * 1000) {
    if (!nonEmpty(identityId) || !nonEmpty(tenantId) || !Number.isFinite(ttlMs) || ttlMs <= 0)
      throw new AuthError('invalid_input');
    const identity = await this.store.findIdentity(identityId);
    if (!identity || identity.status !== 'active') throw new AuthError('unauthorized');
    const token = this.tokens.create();
    const now = this.now();
    const expiresAt = new Date(now.getTime() + ttlMs);
    await this.store.saveSession({
      id: randomUUID(),
      identityId,
      tenantId,
      tokenHash: this.tokens.hash(token),
      createdAt: now,
      lastSeenAt: now,
      expiresAt,
      revokedAt: null,
      authorizationVersion: identity.authorizationVersion,
    });
    return { token, expiresAt } as const;
  }
  public async authenticate(token: string, correlationId: string): Promise<TenantContext> {
    if (!nonEmpty(token) || !nonEmpty(correlationId)) throw new AuthError('unauthorized');
    const session = await this.store.findSession(this.tokens.hash(token));
    if (!session || session.revokedAt || session.expiresAt <= this.now())
      throw new AuthError('unauthorized');
    const identity = await this.store.findIdentity(session.identityId);
    if (
      !identity ||
      identity.status !== 'active' ||
      identity.authorizationVersion !== session.authorizationVersion
    )
      throw new AuthError('unauthorized');
    const membership = await this.store.findMembership(session.tenantId, identity.id);
    if (membership?.status !== 'active') throw new AuthError('unauthorized');
    return Object.freeze({
      tenantId: session.tenantId,
      actor: Object.freeze({ subject: identity.id, kind: 'user' as const }),
      authorizationVersion: identity.authorizationVersion,
      correlationId,
    });
  }
  public async revoke(token: string): Promise<void> {
    if (typeof token !== 'string' || !nonEmpty(token)) throw new AuthError('invalid_input');
    const session = await this.store.findSession(this.tokens.hash(token));
    if (session) await this.store.revokeSession(session.id, this.now());
  }
  public async requirePermission(
    context: TenantContext,
    permission: Permission,
    granted: readonly Permission[],
  ): Promise<void> {
    if (!context.tenantId || context.actor.kind !== 'user' || !granted.includes(permission))
      throw new AuthError('forbidden');
  }
}
