import { randomUUID } from 'node:crypto';
import type {
  IdentityService,
  Permission,
  TenantContext,
  IdentityMutationAudit,
} from '../../../../../packages/domain/identity/src/index.js';
import {
  createAuditEvent,
  type AuditStore,
} from '../../../../../packages/platform/audit/src/index.js';
import type { OutboxStore } from '../../../../../packages/platform/outbox/src/index.js';
import type { AuthApi } from '../../../auth/src/index.js';
import type { AccessDirectory, RoleName } from '../access.js';
import type { DraftStore, RoleDirectory, TenantSettingsStore } from '../directory.js';
import type { InMemoryTenantStore } from '../tenancy.js';
import { PlatformError } from './errors.js';
import type { GatedIdentityService } from './gate.js';

export const ACTOR_PREFIX = 'user-';

export interface PendingInvitation {
  tenantId: string;
  identityId: string;
  role: RoleName;
  expiresAt: Date;
}

export interface KernelParts {
  readonly identity: GatedIdentityService;
  readonly identityOnly: IdentityService;
  readonly auth: AuthApi;
  readonly access: AccessDirectory;
  readonly tenants: InMemoryTenantStore;
  readonly audit: AuditStore;
  readonly outbox: OutboxStore;
  readonly roles: RoleDirectory;
  readonly settings: TenantSettingsStore;
  readonly drafts: DraftStore;
  readonly now: () => Date;
}

/**
 * Shared internal state and helpers of the platform's collaborator modules. It holds the same
 * objects the `Platform` exposes (never copies), plus the pending-invitation map and the per-tenant
 * administrative locks. Not part of the public API.
 */
export class PlatformKernel {
  public readonly identity: GatedIdentityService;
  public readonly identityOnly: IdentityService;
  public readonly auth: AuthApi;
  public readonly access: AccessDirectory;
  public readonly tenants: InMemoryTenantStore;
  public readonly audit: AuditStore;
  public readonly outbox: OutboxStore;
  public readonly roles: RoleDirectory;
  public readonly settings: TenantSettingsStore;
  public readonly drafts: DraftStore;
  public readonly now: () => Date;
  public readonly invitations = new Map<string, PendingInvitation>();
  private readonly locks = new Map<string, Promise<unknown>>();

  public constructor(parts: KernelParts) {
    this.identity = parts.identity;
    this.identityOnly = parts.identityOnly;
    this.auth = parts.auth;
    this.access = parts.access;
    this.tenants = parts.tenants;
    this.audit = parts.audit;
    this.outbox = parts.outbox;
    this.roles = parts.roles;
    this.settings = parts.settings;
    this.drafts = parts.drafts;
    this.now = parts.now;
  }

  public auditNow(
    context: { tenantId: string; actorId: string; actorKind: 'user' | 'system' },
    action: string,
    entityType: string,
    entityId: string,
    correlationId: string,
  ): Promise<void> {
    return this.audit.append(this.auditEvent(context, action, entityType, entityId, correlationId));
  }

  public auditEvent(
    context: { tenantId: string; actorId: string; actorKind: 'user' | 'system' },
    action: string,
    entityType: string,
    entityId: string,
    correlationId: string,
  ): IdentityMutationAudit {
    const event = createAuditEvent(
      { ...context, correlationId },
      {
        eventId: `platform-${randomUUID()}`,
        action,
        entityType,
        entityId,
        occurredAt: this.now().toISOString(),
      },
    );
    return { ...event, actor: { ...event.actor, kind: context.actorKind } };
  }

  public userActor(context: TenantContext) {
    return {
      tenantId: context.tenantId,
      actorId: `user-${context.actor.subject}`,
      actorKind: 'user' as const,
    };
  }

  public async authorize(
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
  public async locked<T>(tenantId: string, work: () => Promise<T>): Promise<T> {
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

  public tenantName(tenantId: string): string {
    const known = this.tenants.all().find((tenant) => tenant.id === tenantId);
    return this.settings.get(tenantId, known?.name ?? 'Empresa').name;
  }

  /** Writes a membership role through to the persistent directory (no-op with in-memory adapters). */
  public async persistRole(
    tenantId: string,
    identityId: string,
    role: RoleName,
    audit?: IdentityMutationAudit,
  ): Promise<void> {
    const persisted = audit
      ? await this.roles.setMemberRoleWithAudit(tenantId, identityId, role, audit)
      : await this.roles.setMemberRole(tenantId, identityId, role);
    if (!persisted) throw new PlatformError('conflict');
  }
}
