import { createHash, randomUUID } from 'node:crypto';
import { InMemoryFileRecordStore } from '../../../../packages/domain/files/src/index.js';
import type { FileRecordStore } from '../../../../packages/domain/files/src/index.js';
import {
  AuthError,
  IdentityService,
  InMemoryIdentityStore,
  opaqueTokenGenerator,
  type IdentityStore,
  type Permission,
  type RecoveryNotifier,
  type TenantContext,
} from '../../../../packages/domain/identity/src/index.js';
import {
  createAuditEvent,
  InMemoryAuditStore,
  type AuditStore,
  type PersistedAuditEvent,
} from '../../../../packages/platform/audit/src/index.js';
import {
  isVerifiedExternalPrincipal,
  verifyExternalPrincipal,
  type OidcVerifier,
  type VerifiedExternalPrincipal,
} from '../../../../packages/platform/auth/src/index.js';
import {
  InMemoryOutboxStore,
  type OutboxStore,
} from '../../../../packages/platform/outbox/src/index.js';
import {
  DownloadGrants,
  FakeScanner,
  FilePipeline,
  InMemoryObjectStorage,
  InMemoryScanQueue,
  type ObjectStorage,
  type PipelineOptions,
  type ScanQueue,
  type VirusScanner,
} from '../../../../packages/platform/files/src/index.js';
import {
  subjectId,
  type SessionId,
  type TenantId,
} from '../../../../packages/domain/tenants/src/index.js';
import { TenantContextResolver } from '../../../../packages/persistence/tenancy/src/index.js';
import { AuthApi } from '../../auth/src/index.js';
import { FilesApi } from '../../files/src/index.js';
import {
  TenantAwareScanQueue,
  createWorkerRuntime,
  type WorkerRuntime,
} from '../../../worker/composition/src/index.js';
import { AccessDirectory, ROLE_PERMISSIONS, isRoleName, type RoleName } from './access.js';
import {
  DraftStore,
  MAX_CUSTOM_ROLES_PER_TENANT,
  MFA_POLICIES,
  ROLE_LABELS,
  RoleCatalog,
  TenantSettingsStore,
  type DraftValues,
  type MfaPolicy,
} from './directory.js';
import { InMemoryTenantStore } from './tenancy.js';

export type PlatformErrorCode =
  | 'invalid_input'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'last_admin';

export class PlatformError extends Error {
  public constructor(public readonly code: PlatformErrorCode) {
    super(`Platform request rejected: ${code}`);
    this.name = 'PlatformError';
  }
}

export interface PlatformResponse<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly error?: { readonly code: string; readonly status: number; readonly message: string };
}

const STATUS: Readonly<Record<PlatformErrorCode | 'internal_error', number>> = {
  invalid_input: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  last_admin: 409,
  internal_error: 500,
};

function failure(error: unknown): PlatformResponse<never> {
  let code: PlatformErrorCode | 'internal_error' = 'internal_error';
  if (error instanceof PlatformError) code = error.code;
  else if (error instanceof AuthError)
    code = error.code === 'expired' ? 'unauthorized' : error.code;
  return {
    ok: false,
    error: {
      code,
      status: STATUS[code],
      message: code === 'internal_error' ? 'Request failed' : `Platform request rejected: ${code}`,
    },
  };
}

const success = <T>(value: T): PlatformResponse<T> => ({ ok: true, value });

/** Opaque id of the control-plane session that mirrors one identity session token. */
export const sessionIdOf = (token: string): SessionId =>
  createHash('sha256').update(token, 'utf8').digest('hex') as SessionId;

/**
 * Re-checks, on every authenticated call, that the control plane still considers the session
 * valid: tenant active, membership active at the same projection version, location verified.
 * Fails closed with the same error as any other authentication failure.
 */
class TenantGate {
  private readonly resolver: TenantContextResolver;
  public constructor(store: InMemoryTenantStore) {
    this.resolver = new TenantContextResolver(store);
  }
  public async assertActive(token: string, context: TenantContext): Promise<void> {
    let resolved: Awaited<ReturnType<TenantContextResolver['resolve']>>;
    try {
      resolved = await this.resolver.resolve({ sessionId: sessionIdOf(token) });
    } catch {
      throw new AuthError('unauthorized');
    }
    if (
      resolved.tenantId !== context.tenantId ||
      resolved.actor.subjectId !== context.actor.subject
    )
      throw new AuthError('unauthorized');
  }
}

/**
 * Identity service whose `authenticate` also passes the tenant gate. Every API built on it
 * (auth, files, admin) therefore rejects suspended tenants and stale control-plane sessions.
 */
class GatedIdentityService extends IdentityService {
  public constructor(
    store: IdentityStore,
    notifier: RecoveryNotifier,
    private readonly gate: TenantGate,
    now: () => Date,
  ) {
    super(store, notifier, opaqueTokenGenerator, now);
  }
  public override async authenticate(token: string, correlationId: string): Promise<TenantContext> {
    const context = await super.authenticate(token, correlationId);
    await this.gate.assertActive(token, context);
    return context;
  }
}

export interface PlatformAdapters {
  readonly identityStore?: IdentityStore;
  readonly storage?: ObjectStorage;
  readonly scanner?: VirusScanner;
  readonly scanQueue?: ScanQueue;
  readonly records?: FileRecordStore;
  readonly audit?: AuditStore;
  readonly outbox?: OutboxStore;
  readonly tenants?: InMemoryTenantStore;
  readonly recoveryNotifier?: RecoveryNotifier;
}

export interface PlatformOptions {
  /** Server-side OIDC verifier (a synthetic one in tests; the real adapter is pending). */
  readonly verifier: OidcVerifier;
  readonly issuer: string;
  /** HMAC secret for download grants, at least 32 characters. */
  readonly grantSecret: string;
  readonly now?: () => Date;
  readonly adapters?: PlatformAdapters;
  readonly pipeline?: Omit<PipelineOptions, 'now'>;
  readonly worker?: { readonly leaseMs?: number; readonly maxAttempts?: number };
  /** How long the scan runner holds back jobs of non-active tenants. */
  readonly scanHoldMs?: number;
}

export interface SessionDetails {
  readonly tenantId: string;
  readonly companyName: string;
  readonly identityId: string;
  readonly roleId: string;
  readonly roleLabel: string;
  readonly permissions: readonly Permission[];
  readonly expiresAt: Date;
}
export interface MemberView {
  readonly id: string;
  readonly roleId: string;
  readonly roleLabel: string;
  readonly status: 'active' | 'invited' | 'inactive';
}
export interface RoleView {
  readonly id: string;
  readonly name: string;
  readonly kind: 'system' | 'custom';
  readonly permissions: readonly Permission[];
  readonly memberCount: number;
}
export interface SettingsView {
  readonly name: string;
  readonly status: 'active' | 'suspended';
  readonly mfa: MfaPolicy;
  readonly sessionIdleHours: number;
}
export interface SettingsInput {
  readonly name: unknown;
  readonly mfa: unknown;
  readonly sessionIdleHours: unknown;
  readonly reason?: unknown;
}
export interface DraftView {
  readonly scope: string;
  readonly values: DraftValues;
  readonly savedAt: Date;
}

const DRAFT_SCOPE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/;
const DRAFT_LIMITS = { keys: 50, keyLength: 64, valueLength: 2000, totalLength: 16_000 } as const;

export interface EmitInput {
  /** Stable opaque id for idempotent re-publication (same id and content is deduplicated per tenant). */
  readonly eventId?: string;
  readonly type: string;
  readonly entityId: string;
  readonly payload: unknown;
  readonly idempotencyKey?: string;
}
export type Emit = (event: EmitInput) => void;

const nonEmpty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 200;

/**
 * Composition root: authentication, tenant control-plane gate, role directory, private files,
 * audit and outbox wired together with in-memory adapters. Tenant, actor and permissions always
 * come from the server-side session, never from caller input.
 */
export class Platform {
  public readonly identity: GatedIdentityService;
  private readonly identityOnly: IdentityService;
  public readonly auth: AuthApi;
  public readonly files: FilesApi;
  public readonly access: AccessDirectory;
  public readonly tenants: InMemoryTenantStore;
  public readonly audit: AuditStore;
  public readonly outbox: OutboxStore;
  public readonly records: FileRecordStore;
  public readonly storage: ObjectStorage;
  public readonly pipeline: FilePipeline;
  public readonly scanQueue: TenantAwareScanQueue;
  public readonly runtime: WorkerRuntime;
  public readonly settings = new TenantSettingsStore();
  public readonly roles = new RoleCatalog();
  public readonly drafts = new DraftStore();
  private readonly invitations = new Map<
    string,
    { tenantId: string; identityId: string; role: RoleName; expiresAt: Date }
  >();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly now: () => Date;

  public constructor(private readonly options: PlatformOptions) {
    this.now = options.now ?? (() => new Date());
    const adapters = options.adapters ?? {};
    this.tenants = adapters.tenants ?? new InMemoryTenantStore(this.now);
    this.audit = adapters.audit ?? new InMemoryAuditStore();
    this.outbox = adapters.outbox ?? new InMemoryOutboxStore(() => this.now().getTime());
    this.records = adapters.records ?? new InMemoryFileRecordStore();
    this.storage = adapters.storage ?? new InMemoryObjectStorage();
    this.access = new AccessDirectory((tenantId) => this.tenants.status(tenantId) === 'active');
    const identityStore = adapters.identityStore ?? new InMemoryIdentityStore();
    const notifier = adapters.recoveryNotifier ?? {
      deliver: async () => {
        throw new Error('recovery notifier is not configured');
      },
    };
    this.identity = new GatedIdentityService(
      identityStore,
      notifier,
      new TenantGate(this.tenants),
      this.now,
    );
    // Ungated view over the same store, private to the composition: used only right after login,
    // before the control-plane session exists. It is never exposed on the public surface.
    this.identityOnly = new IdentityService(
      identityStore,
      notifier,
      opaqueTokenGenerator,
      this.now,
    );
    this.auth = new AuthApi(this.identity, this.access);
    this.scanQueue = new TenantAwareScanQueue(
      adapters.scanQueue ?? new InMemoryScanQueue(),
      this.tenants,
      options.scanHoldMs,
    );
    this.pipeline = new FilePipeline(
      {
        records: this.records,
        storage: this.storage,
        scanner: adapters.scanner ?? new FakeScanner(),
        queue: this.scanQueue,
        audit: this.audit,
      },
      { ...options.pipeline, now: this.now },
    );
    this.files = new FilesApi(this.identity, this.access, {
      records: this.records,
      storage: this.storage,
      pipeline: this.pipeline,
      grants: new DownloadGrants(options.grantSecret, this.now),
      audit: this.audit,
      now: this.now,
    });
    this.runtime = createWorkerRuntime({
      outbox: this.outbox,
      tenants: this.tenants,
      audit: this.audit,
      pipeline: this.pipeline,
      clock: () => this.now().getTime(),
      ...options.worker,
    });
  }

  /** Verifies an authorization code through the injected OIDC verifier and seals the principal. */
  public async verifyPrincipal(
    code: string,
    nonce: string,
  ): Promise<PlatformResponse<VerifiedExternalPrincipal>> {
    try {
      return success(
        await verifyExternalPrincipal(this.options.verifier, code, this.options.issuer, nonce),
      );
    } catch {
      return failure(new PlatformError('unauthorized'));
    }
  }

  private auditNow(
    context: { tenantId: string; actorId: string; actorKind: 'user' | 'system' },
    action: string,
    entityType: string,
    entityId: string,
    correlationId: string,
  ): void {
    this.audit.append(
      createAuditEvent(
        { ...context, correlationId },
        {
          eventId: `platform-${randomUUID()}`,
          action,
          entityType,
          entityId,
          occurredAt: this.now().toISOString(),
        },
      ),
    );
  }

  private userActor(context: TenantContext) {
    return {
      tenantId: context.tenantId,
      actorId: `user-${context.actor.subject}`,
      actorKind: 'user' as const,
    };
  }

  private async authorize(
    token: string,
    correlationId: string,
    required: readonly Permission[],
  ): Promise<TenantContext> {
    const context = await this.identity.authenticate(token, correlationId);
    const granted = await this.access.resolvePermissions(context);
    for (const permission of required)
      await this.identity.requirePermission(context, permission, granted);
    return context;
  }

  /** Serializes administrative changes of one tenant (last-administrator rule). */
  private async locked<T>(tenantId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(tenantId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(work);
    const tail = run.catch(() => undefined);
    this.locks.set(tenantId, tail);
    try {
      return await run;
    } finally {
      if (this.locks.get(tenantId) === tail) this.locks.delete(tenantId);
    }
  }

  /**
   * Creates an active tenant and its first administrator from a verified external principal.
   * If the administrator cannot be activated, the tenant is marked failed and never serves requests.
   */
  public async bootstrapTenant(input: {
    name: string;
    adminPrincipal: unknown;
  }): Promise<PlatformResponse<{ tenantId: string; adminIdentityId: string }>> {
    try {
      if (!isVerifiedExternalPrincipal(input.adminPrincipal))
        throw new PlatformError('unauthorized');
      if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 160)
        throw new PlatformError('invalid_input');
      const tenant = this.tenants.provisionVerified(input.name);
      try {
        const invitation = await this.identity.issueInvitation(tenant.id);
        const activation = await this.identity.activateInvitation(
          invitation.token,
          input.adminPrincipal.provider,
          input.adminPrincipal.subject,
        );
        const identityId = activation.identity.id;
        this.access.grant(tenant.id, identityId, 'admin');
        await this.tenants.projectMembership(tenant.id, subjectId(identityId), 1, 'active');
        this.auditNow(
          { tenantId: tenant.id, actorId: 'system', actorKind: 'system' },
          'tenant.bootstrapped',
          'tenant',
          tenant.id,
          `bootstrap-${tenant.id}`,
        );
        return success({ tenantId: tenant.id, adminIdentityId: identityId });
      } catch (error) {
        await this.tenants.setTenantStatus(tenant.id, 'failed');
        throw error;
      }
    } catch (error) {
      return failure(error);
    }
  }

  /** Operator action (not reachable from a tenant session): the tenant stops serving requests and jobs. */
  public async suspendTenant(tenantId: string): Promise<void> {
    await this.tenants.setTenantStatus(tenantId as TenantId, 'suspended');
    this.auditNow(
      { tenantId, actorId: 'system', actorKind: 'system' },
      'tenant.suspended',
      'tenant',
      tenantId,
      `operator-${randomUUID()}`,
    );
  }

  public async reactivateTenant(tenantId: string): Promise<void> {
    await this.tenants.setTenantStatus(tenantId as TenantId, 'active');
    this.auditNow(
      { tenantId, actorId: 'system', actorKind: 'system' },
      'tenant.reactivated',
      'tenant',
      tenantId,
      `operator-${randomUUID()}`,
    );
  }

  /** Login through the auth API, then mirror the session into the control plane at the current membership version. */
  public async signIn(
    principal: unknown,
  ): Promise<PlatformResponse<{ token: string; expiresAt: Date }>> {
    try {
      const login = await this.auth.login(principal);
      if (!login.ok || !login.value) return failure(new AuthError('unauthorized'));
      const { token, expiresAt } = login.value;
      try {
        const context = await this.identityOnly.authenticate(token, `signin-${randomUUID()}`);
        const membership = await this.tenants.getMembership(
          context.tenantId as TenantId,
          subjectId(context.actor.subject),
        );
        if (membership?.status !== 'active') throw new AuthError('unauthorized');
        await this.tenants.saveSession({
          id: sessionIdOf(token),
          subjectId: membership.subjectId,
          tenantId: membership.tenantId,
          authorizationVersion: membership.version,
          expiresAt,
          revoked: false,
        });
      } catch (error) {
        await this.identity.revoke(token);
        throw error;
      }
      return success({ token, expiresAt });
    } catch (error) {
      return failure(error);
    }
  }

  public async signOut(token: string): Promise<PlatformResponse<null>> {
    try {
      await this.identity.revoke(token);
      const mirrored = await this.tenants.getSession(sessionIdOf(token));
      if (mirrored) await this.tenants.saveSession({ ...mirrored, revoked: true });
      return success(null);
    } catch (error) {
      return failure(error);
    }
  }

  public async session(
    token: string,
    correlationId: string,
  ): Promise<PlatformResponse<TenantContext>> {
    try {
      return success(await this.identity.authenticate(token, correlationId));
    } catch (error) {
      return failure(error);
    }
  }

  public async inviteUser(
    token: string,
    correlationId: string,
    role: RoleName,
  ): Promise<PlatformResponse<{ invitationToken: string; expiresAt: Date; identityId: string }>> {
    try {
      if (!isRoleName(role)) throw new PlatformError('invalid_input');
      const context = await this.authorize(token, correlationId, ['manage_users']);
      const invitation = await this.identity.issueInvitation(context.tenantId);
      this.access.expectInvitation(invitation.identityId, context.tenantId, role);
      const nowMs = this.now().getTime();
      for (const [hash, meta] of this.invitations)
        if (meta.expiresAt.getTime() <= nowMs) this.invitations.delete(hash);
      this.invitations.set(opaqueTokenGenerator.hash(invitation.token), {
        tenantId: context.tenantId,
        identityId: invitation.identityId,
        role,
        expiresAt: invitation.expiresAt,
      });
      this.auditNow(
        this.userActor(context),
        'user.invited',
        'membership',
        invitation.identityId,
        correlationId,
      );
      return success({
        invitationToken: invitation.token,
        expiresAt: invitation.expiresAt,
        identityId: invitation.identityId,
      });
    } catch (error) {
      return failure(error);
    }
  }

  /** Activates an invitation for a verified principal and projects the new membership into the control plane. */
  public async acceptInvitation(
    invitationToken: string,
    principal: unknown,
  ): Promise<PlatformResponse<{ identityId: string; tenantId: string }>> {
    try {
      const activated = await this.auth.activateInvitation(invitationToken, principal);
      if (!activated.ok || !activated.value) return failure(new AuthError('unauthorized'));
      const { identity, membership } = activated.value;
      this.invitations.delete(opaqueTokenGenerator.hash(invitationToken));
      if (!this.access.activate(identity.id, membership.tenantId)) {
        // No role was recorded for this invitation: it did not come from `inviteUser`; fail closed.
        await this.identity.revokeMembership(membership.tenantId, identity.id);
        throw new PlatformError('forbidden');
      }
      const current = await this.tenants.getMembership(
        membership.tenantId as TenantId,
        subjectId(identity.id),
      );
      await this.tenants.projectMembership(
        membership.tenantId as TenantId,
        subjectId(identity.id),
        (current?.version ?? 0) + 1,
        'active',
      );
      this.auditNow(
        { tenantId: membership.tenantId, actorId: `user-${identity.id}`, actorKind: 'user' },
        'user.joined',
        'membership',
        identity.id,
        `accept-${randomUUID()}`,
      );
      return success({ identityId: identity.id, tenantId: membership.tenantId });
    } catch (error) {
      return failure(error);
    }
  }

  private async bumpProjection(
    tenantId: string,
    identityId: string,
    status: 'active' | 'revoked',
  ): Promise<void> {
    const current = await this.tenants.getMembership(tenantId as TenantId, subjectId(identityId));
    await this.tenants.projectMembership(
      tenantId as TenantId,
      subjectId(identityId),
      (current?.version ?? 0) + 1,
      status,
    );
  }

  private async adminOperation<T>(
    token: string,
    correlationId: string,
    targetIdentityId: string,
    work: (context: TenantContext) => Promise<T>,
  ): Promise<PlatformResponse<T>> {
    try {
      if (!nonEmpty(targetIdentityId)) throw new PlatformError('invalid_input');
      const first = await this.identity.authenticate(token, correlationId);
      return success(
        await this.locked(first.tenantId, async () => {
          // Authorize again inside the lock: an earlier queued change may have revoked this actor.
          const context = await this.authorize(token, correlationId, ['manage_users']);
          return work(context);
        }),
      );
    } catch (error) {
      return failure(error);
    }
  }

  /**
   * Changes the role of a member of the caller's tenant. The membership projection version is
   * bumped, so the target's existing sessions stop working and a new login picks up the new role.
   */
  public changeRole(
    token: string,
    correlationId: string,
    targetIdentityId: string,
    role: RoleName,
  ): Promise<PlatformResponse<null>> {
    return this.adminOperation(token, correlationId, targetIdentityId, async (context) => {
      if (!isRoleName(role)) throw new PlatformError('invalid_input');
      const current = this.access.roleOf(context.tenantId, targetIdentityId);
      if (!current) throw new PlatformError('not_found');
      if (
        current === 'admin' &&
        role !== 'admin' &&
        this.access.activeAdmins(context.tenantId).length <= 1
      )
        throw new PlatformError('last_admin');
      this.access.setRole(context.tenantId, targetIdentityId, role);
      await this.bumpProjection(context.tenantId, targetIdentityId, 'active');
      this.auditNow(
        this.userActor(context),
        'membership.role_changed',
        'membership',
        targetIdentityId,
        correlationId,
      );
      return null;
    });
  }

  /**
   * Revokes a membership of the caller's tenant (identity sessions end through the authorization
   * version bump). Serialized per tenant so two concurrent removals cannot delete the last administrator.
   */
  public removeMember(
    token: string,
    correlationId: string,
    targetIdentityId: string,
  ): Promise<PlatformResponse<null>> {
    return this.adminOperation(token, correlationId, targetIdentityId, async (context) => {
      const current = this.access.roleOf(context.tenantId, targetIdentityId);
      if (!current) throw new PlatformError('not_found');
      if (current === 'admin' && this.access.activeAdmins(context.tenantId).length <= 1)
        throw new PlatformError('last_admin');
      await this.identity.revokeMembership(context.tenantId, targetIdentityId);
      this.access.revoke(context.tenantId, targetIdentityId);
      await this.bumpProjection(context.tenantId, targetIdentityId, 'revoked');
      this.auditNow(
        this.userActor(context),
        'membership.revoked',
        'membership',
        targetIdentityId,
        correlationId,
      );
      return null;
    });
  }

  private tenantName(tenantId: string): string {
    const known = this.tenants.all().find((tenant) => tenant.id === tenantId);
    return this.settings.get(tenantId, known?.name ?? 'Empresa').name;
  }

  /** What the browser may know about its own session: never a token. Fails closed like any authentication. */
  public async sessionDetails(
    token: string,
    correlationId: string,
  ): Promise<PlatformResponse<SessionDetails>> {
    try {
      const context = await this.identity.authenticate(token, correlationId);
      const role = this.access.roleOf(context.tenantId, context.actor.subject);
      const mirrored = await this.tenants.getSession(sessionIdOf(token));
      if (!role || !mirrored) throw new AuthError('unauthorized');
      return success({
        tenantId: context.tenantId,
        companyName: this.tenantName(context.tenantId),
        identityId: context.actor.subject,
        roleId: role,
        roleLabel: ROLE_LABELS[role],
        permissions: await this.access.resolvePermissions(context),
        expiresAt: mirrored.expiresAt,
      });
    } catch (error) {
      return failure(error);
    }
  }

  /**
   * Public preview of an invitation (company and role) for the person about to accept it. Unknown,
   * expired, used and revoked invitations are indistinguishable: all answer not_found.
   */
  public async inspectInvitation(
    invitationToken: string,
  ): Promise<PlatformResponse<{ companyName: string; roleLabel: string }>> {
    try {
      if (typeof invitationToken !== 'string' || !invitationToken || invitationToken.length > 512)
        throw new PlatformError('not_found');
      const hash = opaqueTokenGenerator.hash(invitationToken);
      const meta = this.invitations.get(hash);
      if (!meta) throw new PlatformError('not_found');
      const expired = meta.expiresAt.getTime() <= this.now().getTime();
      if (
        expired ||
        !this.access.hasPending(meta.identityId, meta.tenantId) ||
        this.tenants.status(meta.tenantId) !== 'active'
      ) {
        if (expired) this.invitations.delete(hash);
        throw new PlatformError('not_found');
      }
      return success({
        companyName: this.tenantName(meta.tenantId),
        roleLabel: ROLE_LABELS[meta.role],
      });
    } catch (error) {
      return failure(error);
    }
  }

  /** Members and pending invitations of the caller's tenant (`manage_users`). */
  public async listMembers(
    token: string,
    correlationId: string,
  ): Promise<PlatformResponse<{ tenantId: string; members: readonly MemberView[] }>> {
    try {
      const context = await this.authorize(token, correlationId, ['manage_users']);
      const status = { active: 'active', pending: 'invited', revoked: 'inactive' } as const;
      return success({
        tenantId: context.tenantId,
        members: this.access.membersOf(context.tenantId).map((member) => ({
          id: member.identityId,
          roleId: member.role,
          roleLabel: ROLE_LABELS[member.role],
          status: status[member.status],
        })),
      });
    } catch (error) {
      return failure(error);
    }
  }

  private roleViews(tenantId: string): readonly RoleView[] {
    const members = this.access.membersOf(tenantId);
    const count = (roleId: string) =>
      members.filter((member) => member.status === 'active' && member.role === roleId).length;
    const system = (Object.keys(ROLE_LABELS) as RoleName[]).map((id) => ({
      id,
      name: ROLE_LABELS[id],
      kind: 'system' as const,
      permissions: ROLE_PERMISSIONS[id],
      memberCount: count(id),
    }));
    const custom = this.roles.custom(tenantId).map((role) => ({
      id: role.id,
      name: role.name,
      kind: 'custom' as const,
      permissions: role.permissions,
      memberCount: 0,
    }));
    return [...system, ...custom];
  }

  /** System templates plus the tenant's custom roles (`manage_users`). */
  public async listRoles(
    token: string,
    correlationId: string,
  ): Promise<PlatformResponse<readonly RoleView[]>> {
    try {
      const context = await this.authorize(token, correlationId, ['manage_users']);
      return success(this.roleViews(context.tenantId));
    } catch (error) {
      return failure(error);
    }
  }

  /** Copies a role of the caller's tenant (or a system template) under a new name (`manage_users`). */
  public async copyRole(
    token: string,
    correlationId: string,
    roleId: string,
    name: unknown,
  ): Promise<PlatformResponse<RoleView>> {
    try {
      const context = await this.authorize(token, correlationId, ['manage_users']);
      const source = typeof roleId === 'string' ? this.roles.find(context.tenantId, roleId) : null;
      if (!source) throw new PlatformError('not_found');
      const trimmed = typeof name === 'string' ? name.trim() : '';
      if (!trimmed || trimmed.length > 80) throw new PlatformError('invalid_input');
      if (
        this.roles.nameTaken(context.tenantId, trimmed) ||
        this.roles.custom(context.tenantId).length >= MAX_CUSTOM_ROLES_PER_TENANT
      )
        throw new PlatformError('conflict');
      const role = { id: `custom-${randomUUID()}`, name: trimmed, permissions: source.permissions };
      this.roles.add(context.tenantId, role);
      this.auditNow(this.userActor(context), 'role.copied', 'role', role.id, correlationId);
      return success({ ...role, kind: 'custom' as const, memberCount: 0 });
    } catch (error) {
      return failure(error);
    }
  }

  private settingsView(tenantId: string): SettingsView {
    const stored = this.settings.get(tenantId, 'Empresa');
    return {
      ...stored,
      name: this.tenantName(tenantId),
      status: this.tenants.status(tenantId) === 'active' ? 'active' : 'suspended',
    };
  }

  public async getSettings(
    token: string,
    correlationId: string,
  ): Promise<PlatformResponse<SettingsView>> {
    try {
      const context = await this.authorize(token, correlationId, ['manage_config']);
      return success(this.settingsView(context.tenantId));
    } catch (error) {
      return failure(error);
    }
  }

  /**
   * Updates the caller's company settings (`manage_config`). Changing a security setting requires a
   * reason; it is validated but not stored (free text may carry personal data), and the change is audited.
   */
  public async updateSettings(
    token: string,
    correlationId: string,
    input: SettingsInput,
  ): Promise<PlatformResponse<SettingsView>> {
    try {
      const context = await this.authorize(token, correlationId, ['manage_config']);
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      const hours = input.sessionIdleHours;
      if (
        !name ||
        name.length > 160 ||
        !MFA_POLICIES.includes(input.mfa as MfaPolicy) ||
        typeof hours !== 'number' ||
        !Number.isInteger(hours) ||
        hours < 1 ||
        hours > 24
      )
        throw new PlatformError('invalid_input');
      const reason = input.reason;
      if (reason !== undefined && (typeof reason !== 'string' || reason.length > 500))
        throw new PlatformError('invalid_input');
      const current = this.settingsView(context.tenantId);
      const securityChanged = current.mfa !== input.mfa || current.sessionIdleHours !== hours;
      if (securityChanged && !(typeof reason === 'string' && reason.trim()))
        throw new PlatformError('invalid_input');
      this.settings.set(context.tenantId, {
        name,
        mfa: input.mfa as MfaPolicy,
        sessionIdleHours: hours,
      });
      this.auditNow(
        this.userActor(context),
        securityChanged ? 'tenant.security_settings_updated' : 'tenant.settings_updated',
        'tenant',
        context.tenantId,
        correlationId,
      );
      return success(this.settingsView(context.tenantId));
    } catch (error) {
      return failure(error);
    }
  }

  /** Drafts belong to the signed-in person; no permission beyond a valid session is needed. */
  public async loadDraft(
    token: string,
    correlationId: string,
    scope: string,
  ): Promise<PlatformResponse<DraftView | null>> {
    try {
      const context = await this.identity.authenticate(token, correlationId);
      if (typeof scope !== 'string' || !DRAFT_SCOPE.test(scope))
        throw new PlatformError('invalid_input');
      return success(this.drafts.load(context.tenantId, context.actor.subject, scope));
    } catch (error) {
      return failure(error);
    }
  }

  public async saveDraft(
    token: string,
    correlationId: string,
    scope: string,
    values: unknown,
  ): Promise<PlatformResponse<DraftView>> {
    try {
      const context = await this.identity.authenticate(token, correlationId);
      if (typeof scope !== 'string' || !DRAFT_SCOPE.test(scope))
        throw new PlatformError('invalid_input');
      if (typeof values !== 'object' || values === null || Array.isArray(values))
        throw new PlatformError('invalid_input');
      const entries = Object.entries(values);
      let total = 0;
      for (const [key, value] of entries) {
        if (
          typeof value !== 'string' ||
          key.length === 0 ||
          key.length > DRAFT_LIMITS.keyLength ||
          value.length > DRAFT_LIMITS.valueLength
        )
          throw new PlatformError('invalid_input');
        total += key.length + value.length;
      }
      if (entries.length > DRAFT_LIMITS.keys || total > DRAFT_LIMITS.totalLength)
        throw new PlatformError('invalid_input');
      const record: DraftView = {
        scope,
        values: Object.freeze(Object.fromEntries(entries) as Record<string, string>),
        savedAt: this.now(),
      };
      if (!this.drafts.save(context.tenantId, context.actor.subject, record))
        throw new PlatformError('conflict');
      return success(record);
    } catch (error) {
      return failure(error);
    }
  }

  public async discardDraft(
    token: string,
    correlationId: string,
    scope: string,
  ): Promise<PlatformResponse<null>> {
    try {
      const context = await this.identity.authenticate(token, correlationId);
      if (typeof scope !== 'string' || !DRAFT_SCOPE.test(scope))
        throw new PlatformError('invalid_input');
      this.drafts.discard(context.tenantId, context.actor.subject, scope);
      return success(null);
    } catch (error) {
      return failure(error);
    }
  }

  /** Audit trail of the caller's tenant only; there is no way to name another tenant. */
  public async listAudit(
    token: string,
    correlationId: string,
  ): Promise<PlatformResponse<readonly PersistedAuditEvent[]>> {
    try {
      const context = await this.authorize(token, correlationId, ['view_audit']);
      return success(this.audit.list(context.tenantId));
    } catch (error) {
      return failure(error);
    }
  }

  /**
   * Runs `work` in an outbox transaction scoped to the caller's tenant. If `work` throws, nothing
   * is published. Tenant, actor and correlation come from the session, not from the event input.
   */
  public async publish<T>(
    token: string,
    correlationId: string,
    work: (emit: Emit) => T,
    permission: Permission = 'create',
  ): Promise<PlatformResponse<T>> {
    try {
      const context = await this.authorize(token, correlationId, [permission]);
      const result = this.outbox.transaction((tx) =>
        work((event) => {
          tx.enqueue({
            eventId: event.eventId ?? `evt-${randomUUID()}`,
            tenantId: context.tenantId,
            type: event.type,
            payload: event.payload,
            occurredAt: this.now().toISOString(),
            idempotencyKey: event.idempotencyKey ?? randomUUID(),
            correlationId,
            actorRef: { subject: `user-${context.actor.subject}`, kind: 'user' },
            entityId: event.entityId,
            schemaVersion: 1,
          });
        }),
      );
      return success(result);
    } catch (error) {
      return failure(error);
    }
  }
}

export function createPlatform(options: PlatformOptions): Platform {
  return new Platform(options);
}
