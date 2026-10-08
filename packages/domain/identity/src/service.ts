import { randomUUID } from 'node:crypto';
import { AuthError } from './errors.js';
import {
  opaqueTokenGenerator,
  type IdentityStore,
  type IdentityMutationAudit,
  type RecoveryNotifier,
  type TokenGenerator,
} from './ports.js';
import {
  type ExternalIdentity,
  type Identity,
  type Invitation,
  type InvitationActivation,
  type Membership,
  type Permission,
  type TenantContext,
} from './types.js';
import { nonEmpty } from './validation.js';

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
  public get supportsAtomicAudit(): boolean {
    return this.store.supportsAtomicAudit === true;
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
    options?: { readonly role?: string; readonly audit?: IdentityMutationAudit },
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
    if (options?.audit) {
      if (!options.role || !this.store.createInvitationWithRoleAndAudit)
        throw new AuthError('conflict');
      await this.store.createInvitationWithRoleAndAudit(
        identity,
        membership,
        invitation,
        options.role,
        { ...options.audit, entityId: identity.id },
        now,
      );
    } else {
      await this.store.createInvitation(identity, membership, invitation, now);
    }
    return { id: invitation.id, identityId, token, expiresAt: invitation.expiresAt } as const;
  }
  public async activateInvitation(
    token: string,
    provider: string,
    subject: string,
    audit?: IdentityMutationAudit,
  ): Promise<InvitationActivation> {
    if (!nonEmpty(token) || !nonEmpty(provider) || !nonEmpty(subject))
      throw new AuthError('unauthorized');
    const args = [this.tokens.hash(token), provider, subject, this.now()] as const;
    const result = audit
      ? await this.store.activateInvitationWithAudit?.(...args, audit)
      : await this.store.activateInvitation(...args);
    if (audit && !this.store.activateInvitationWithAudit) throw new AuthError('conflict');
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
  public async revokeMembership(
    tenantId: string,
    identityId: string,
    audit?: IdentityMutationAudit,
  ): Promise<void> {
    if (!nonEmpty(tenantId) || !nonEmpty(identityId)) throw new AuthError('invalid_input');
    const revoked = audit
      ? await this.store.revokeMembershipWithAudit?.(tenantId, identityId, audit)
      : await this.store.revokeMembership(tenantId, identityId);
    if (audit && !this.store.revokeMembershipWithAudit) throw new AuthError('conflict');
    if (!revoked) throw new AuthError('not_found');
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
