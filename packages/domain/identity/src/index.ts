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
export interface RecoveryRequest {
  readonly id: string;
  readonly identityId: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly usedAt: Date | null;
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
  findInvitation(tokenHash: string): Promise<Invitation | null>;
  saveInvitation(invitation: Invitation): Promise<void>;
  consumeInvitation(id: string, consumedAt: Date): Promise<boolean>;
  findRecovery(tokenHash: string): Promise<RecoveryRequest | null>;
  saveRecovery(request: RecoveryRequest): Promise<void>;
  consumeRecovery(id: string, usedAt: Date): Promise<boolean>;
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
  public async findInvitation(tokenHash: string) {
    return (
      [...this.invitations.values()].find((item) => sameSecret(item.tokenHash, tokenHash)) ?? null
    );
  }
  public async saveInvitation(invitation: Invitation) {
    this.invitations.set(invitation.id, invitation);
  }
  public async consumeInvitation(id: string, consumedAt: Date) {
    const item = this.invitations.get(id);
    if (!item || item.consumedAt) return false;
    this.invitations.set(id, { ...item, consumedAt });
    return true;
  }
  public async findRecovery(tokenHash: string) {
    return (
      [...this.recoveries.values()].find((item) => sameSecret(item.tokenHash, tokenHash)) ?? null
    );
  }
  public async saveRecovery(request: RecoveryRequest) {
    this.recoveries.set(request.id, request);
  }
  public async consumeRecovery(id: string, usedAt: Date) {
    const item = this.recoveries.get(id);
    if (!item || item.usedAt) return false;
    this.recoveries.set(id, { ...item, usedAt });
    return true;
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

const nonEmpty = (value: string): boolean => value.trim().length > 0 && value.length <= 200;
export class IdentityService {
  public constructor(
    private readonly store: IdentityStore,
    private readonly recoveryNotifier: RecoveryNotifier,
    private readonly tokens: TokenGenerator = opaqueTokenGenerator,
    private readonly now: () => Date = () => new Date(),
  ) {}
  public async linkExternal(provider: string, subject: string): Promise<Identity> {
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
  public async issueInvitation(tenantId: string, identityId: string, ttlMs = 72 * 60 * 60 * 1000) {
    if (!nonEmpty(tenantId) || !nonEmpty(identityId) || !Number.isFinite(ttlMs) || ttlMs <= 0)
      throw new AuthError('invalid_input');
    if (!(await this.store.findIdentity(identityId))) throw new AuthError('not_found');
    const token = this.tokens.create();
    const invitation: Invitation = {
      id: randomUUID(),
      tenantId,
      identityId,
      tokenHash: this.tokens.hash(token),
      expiresAt: new Date(this.now().getTime() + ttlMs),
      consumedAt: null,
    };
    await this.store.saveInvitation(invitation);
    return { id: invitation.id, token, expiresAt: invitation.expiresAt } as const;
  }
  public async activateInvitation(token: string): Promise<Identity> {
    if (!nonEmpty(token)) throw new AuthError('invalid_input');
    const item = await this.store.findInvitation(this.tokens.hash(token));
    if (!item || item.consumedAt || item.expiresAt <= this.now())
      throw new AuthError('unauthorized');
    if (!(await this.store.consumeInvitation(item.id, this.now()))) throw new AuthError('conflict');
    const identity = await this.store.findIdentity(item.identityId);
    if (!identity || identity.status !== 'active') throw new AuthError('unauthorized');
    return identity;
  }
  public async requestRecovery(
    identityId: string,
    ttlMs = 60 * 60 * 1000,
  ): Promise<{ accepted: true }> {
    if (!nonEmpty(identityId) || !Number.isFinite(ttlMs) || ttlMs <= 0)
      throw new AuthError('invalid_input');
    const token = this.tokens.create();
    const identity = await this.store.findIdentity(identityId);
    if (identity?.status === 'active') {
      const expiresAt = new Date(this.now().getTime() + ttlMs);
      await this.store.saveRecovery({
        id: randomUUID(),
        identityId,
        tokenHash: this.tokens.hash(token),
        expiresAt,
        usedAt: null,
      });
      try {
        await this.recoveryNotifier.deliver(identity.id, token, expiresAt);
      } catch {
        // Preserve the same public response for existing and unknown identities.
      }
    }
    return { accepted: true };
  }
  public async consumeRecovery(token: string): Promise<Identity> {
    if (!nonEmpty(token)) throw new AuthError('invalid_input');
    const request = await this.store.findRecovery(this.tokens.hash(token));
    if (!request || request.usedAt || request.expiresAt <= this.now())
      throw new AuthError('unauthorized');
    if (!(await this.store.consumeRecovery(request.id, this.now())))
      throw new AuthError('conflict');
    const identity = await this.store.findIdentity(request.identityId);
    if (!identity || identity.status !== 'active') throw new AuthError('unauthorized');
    return identity;
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
    return Object.freeze({
      tenantId: session.tenantId,
      actor: Object.freeze({ subject: identity.id, kind: 'user' as const }),
      authorizationVersion: identity.authorizationVersion,
      correlationId,
    });
  }
  public async revoke(token: string): Promise<void> {
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
