import { InMemoryFileRecordStore } from '../../../../packages/domain/files/src/index.js';
import type { FileRecordStore } from '../../../../packages/domain/files/src/index.js';
import {
  IdentityService,
  InMemoryIdentityStore,
  opaqueTokenGenerator,
  type Permission,
  type TenantContext,
} from '../../../../packages/domain/identity/src/index.js';
import {
  InMemoryAuditStore,
  type AuditStore,
  type PersistedAuditEvent,
} from '../../../../packages/platform/audit/src/index.js';
import {
  verifyExternalPrincipal,
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
} from '../../../../packages/platform/files/src/index.js';
import { AuthApi } from '../../auth/src/index.js';
import { FilesApi } from '../../files/src/index.js';
import { TenantAwareScanQueue, type WorkerRuntime } from '../../../worker/composition/src/index.js';
import { AccessDirectory, isStoredRoleReader, type RoleName } from './access.js';
import {
  DraftStore,
  RoleDirectory,
  TenantSettingsStore,
  isRoleDirectoryStore,
} from './directory.js';
import { InMemoryTenantStore } from './tenancy.js';
import type { AreasApi } from './areas.js';
import type { DocumentsApi } from './documents.js';
import type { AssignmentsApi } from './assignments.js';
import type { ImportsApi } from './imports.js';
import type { AlertsApi } from './alerts.js';
import type { CompanySettingsApi } from './settings.js';
import type { InsuranceApi } from './insurance.js';
import type { EmployeesApi } from './employees.js';
import type { VehiclesApi } from './vehicles.js';
import { buildDomainApis } from './platform/apis.js';
import { acceptInvitation, inspectInvitation, inviteUser } from './platform/invitations.js';
import { PlatformError, failure, success, type PlatformResponse } from './platform/errors.js';
import { listAudit, publish } from './platform/events.js';
import { GatedIdentityService, TenantGate } from './platform/gate.js';
import { PlatformKernel } from './platform/kernel.js';
import { buildWorkerRuntime } from './platform/runtime.js';
import { discardDraft, loadDraft, saveDraft } from './platform/drafts.js';
import { changeRole, copyRole, listMembers, listRoles, removeMember } from './platform/members.js';
import {
  bootstrapTenant,
  reactivateTenant,
  session,
  sessionDetails,
  signIn,
  signOut,
  suspendTenant,
} from './platform/sessions.js';
import { getSettings, updateSettings } from './platform/settings.js';
import type {
  DraftView,
  Emit,
  MemberView,
  PlatformOptions,
  RoleView,
  SessionDetails,
  SettingsInput,
  SettingsView,
} from './platform/types.js';

export { PlatformError, type PlatformErrorCode, type PlatformResponse } from './platform/errors.js';
export { sessionIdOf } from './platform/gate.js';
export type {
  DraftView,
  Emit,
  EmitInput,
  MemberView,
  PlatformAdapters,
  PlatformOptions,
  RoleView,
  SessionDetails,
  SettingsInput,
  SettingsView,
} from './platform/types.js';

/**
 * Composition root: authentication, tenant control-plane gate, role directory, private files,
 * audit and outbox wired together with in-memory adapters. Tenant, actor and permissions always
 * come from the server-side session, never from caller input. The feature methods delegate to the
 * collaborator modules in `./platform/`, which share state through a private `PlatformKernel`.
 */
export class Platform {
  public readonly identity: GatedIdentityService;
  private readonly identityOnly: IdentityService;
  public readonly auth: AuthApi;
  public readonly files: FilesApi;
  public readonly vehicles: VehiclesApi;
  public readonly areas: AreasApi;
  public readonly employees: EmployeesApi;
  public readonly documents: DocumentsApi;
  public readonly insurance: InsuranceApi;
  public readonly assignments: AssignmentsApi;
  public readonly imports: ImportsApi;
  public readonly companySettings: CompanySettingsApi;
  public readonly alerts: AlertsApi;
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
  public readonly roles: RoleDirectory;
  public readonly drafts = new DraftStore();
  private readonly kernel: PlatformKernel;
  /** The kernel's pending-invitation registry (same map), kept reachable for white-box tests. */
  protected readonly invitations: ReadonlyMap<string, unknown>;
  private readonly now: () => Date;

  public constructor(private readonly options: PlatformOptions) {
    this.now = options.now ?? (() => new Date());
    const adapters = options.adapters ?? {};
    this.tenants = adapters.tenants ?? new InMemoryTenantStore(this.now);
    this.audit = adapters.audit ?? new InMemoryAuditStore();
    this.outbox = adapters.outbox ?? new InMemoryOutboxStore(() => this.now().getTime());
    this.records = adapters.records ?? new InMemoryFileRecordStore();
    this.storage = adapters.storage ?? new InMemoryObjectStorage();
    const identityStore = adapters.identityStore ?? new InMemoryIdentityStore();
    this.access = new AccessDirectory(
      (tenantId) => this.tenants.status(tenantId) === 'active',
      isStoredRoleReader(identityStore) ? identityStore : undefined,
    );
    this.roles = new RoleDirectory(
      adapters.roleStore ?? (isRoleDirectoryStore(identityStore) ? identityStore : undefined),
    );
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
    this.kernel = new PlatformKernel({
      identity: this.identity,
      identityOnly: this.identityOnly,
      auth: this.auth,
      access: this.access,
      tenants: this.tenants,
      audit: this.audit,
      outbox: this.outbox,
      roles: this.roles,
      settings: this.settings,
      drafts: this.drafts,
      now: this.now,
    });
    this.invitations = this.kernel.invitations;
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
    const apis = buildDomainApis(this.kernel, adapters);
    this.vehicles = apis.vehicles;
    this.areas = apis.areas;
    this.employees = apis.employees;
    this.documents = apis.documents;
    this.insurance = apis.insurance;
    this.assignments = apis.assignments;
    this.imports = apis.imports;
    this.companySettings = apis.companySettings;
    this.alerts = apis.alerts;
    this.runtime = buildWorkerRuntime(this.kernel, this.pipeline, options.worker);
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

  /**
   * Creates an active tenant and its first administrator from a verified external principal.
   * If the administrator cannot be activated, the tenant is marked failed and never serves requests.
   */
  public bootstrapTenant(input: {
    name: string;
    adminPrincipal: unknown;
  }): Promise<PlatformResponse<{ tenantId: string; adminIdentityId: string }>> {
    return bootstrapTenant(this.kernel, input);
  }

  /** Operator action (not reachable from a tenant session): the tenant stops serving requests and jobs. */
  public suspendTenant(tenantId: string): Promise<void> {
    return suspendTenant(this.kernel, tenantId);
  }

  public reactivateTenant(tenantId: string): Promise<void> {
    return reactivateTenant(this.kernel, tenantId);
  }

  /** Login through the auth API, then mirror the session into the control plane at the current membership version. */
  public signIn(principal: unknown): Promise<PlatformResponse<{ token: string; expiresAt: Date }>> {
    return signIn(this.kernel, principal);
  }

  public signOut(token: string): Promise<PlatformResponse<null>> {
    return signOut(this.kernel, token);
  }

  public session(token: string, correlationId: string): Promise<PlatformResponse<TenantContext>> {
    return session(this.kernel, token, correlationId);
  }

  /** What the browser may know about its own session: never a token. Fails closed like any authentication. */
  public sessionDetails(
    token: string,
    correlationId: string,
  ): Promise<PlatformResponse<SessionDetails>> {
    return sessionDetails(this.kernel, token, correlationId);
  }

  public inviteUser(
    token: string,
    correlationId: string,
    role: RoleName,
  ): Promise<PlatformResponse<{ invitationToken: string; expiresAt: Date; identityId: string }>> {
    return inviteUser(this.kernel, token, correlationId, role);
  }

  /** Activates an invitation for a verified principal and projects the new membership into the control plane. */
  public acceptInvitation(
    invitationToken: string,
    principal: unknown,
  ): Promise<PlatformResponse<{ identityId: string; tenantId: string }>> {
    return acceptInvitation(this.kernel, invitationToken, principal);
  }

  /**
   * Public preview of an invitation (company and role) for the person about to accept it. Unknown,
   * expired, used and revoked invitations are indistinguishable: all answer not_found.
   */
  public inspectInvitation(
    invitationToken: string,
  ): Promise<PlatformResponse<{ companyName: string; roleLabel: string }>> {
    return inspectInvitation(this.kernel, invitationToken);
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
    return changeRole(this.kernel, token, correlationId, targetIdentityId, role);
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
    return removeMember(this.kernel, token, correlationId, targetIdentityId);
  }

  /** Members and pending invitations of the caller's tenant (`manage_users`). */
  public listMembers(
    token: string,
    correlationId: string,
  ): Promise<PlatformResponse<{ tenantId: string; members: readonly MemberView[] }>> {
    return listMembers(this.kernel, token, correlationId);
  }

  /** System templates plus the tenant's custom roles (`manage_users`). */
  public listRoles(
    token: string,
    correlationId: string,
  ): Promise<PlatformResponse<readonly RoleView[]>> {
    return listRoles(this.kernel, token, correlationId);
  }

  /** Copies a role of the caller's tenant (or a system template) under a new name (`manage_users`). */
  public copyRole(
    token: string,
    correlationId: string,
    roleId: string,
    name: unknown,
  ): Promise<PlatformResponse<RoleView>> {
    return copyRole(this.kernel, token, correlationId, roleId, name);
  }

  public getSettings(
    token: string,
    correlationId: string,
  ): Promise<PlatformResponse<SettingsView>> {
    return getSettings(this.kernel, token, correlationId);
  }

  /**
   * Updates the caller's company settings (`manage_config`). Changing a security setting requires a
   * reason; it is validated but not stored (free text may carry personal data), and the change is audited.
   */
  public updateSettings(
    token: string,
    correlationId: string,
    input: SettingsInput,
  ): Promise<PlatformResponse<SettingsView>> {
    return updateSettings(this.kernel, token, correlationId, input);
  }

  /** Drafts belong to the signed-in person; no permission beyond a valid session is needed. */
  public loadDraft(
    token: string,
    correlationId: string,
    scope: string,
  ): Promise<PlatformResponse<DraftView | null>> {
    return loadDraft(this.kernel, token, correlationId, scope);
  }

  public saveDraft(
    token: string,
    correlationId: string,
    scope: string,
    values: unknown,
  ): Promise<PlatformResponse<DraftView>> {
    return saveDraft(this.kernel, token, correlationId, scope, values);
  }

  public discardDraft(
    token: string,
    correlationId: string,
    scope: string,
  ): Promise<PlatformResponse<null>> {
    return discardDraft(this.kernel, token, correlationId, scope);
  }

  /** Audit trail of the caller's tenant only; there is no way to name another tenant. */
  public listAudit(
    token: string,
    correlationId: string,
  ): Promise<PlatformResponse<readonly PersistedAuditEvent[]>> {
    return listAudit(this.kernel, token, correlationId);
  }

  /**
   * Runs `work` in an outbox transaction scoped to the caller's tenant. If `work` throws, nothing
   * is published. Tenant, actor and correlation come from the session, not from the event input.
   */
  public publish<T>(
    token: string,
    correlationId: string,
    work: (emit: Emit) => T,
    permission: Permission = 'create',
  ): Promise<PlatformResponse<T>> {
    return publish(this.kernel, token, correlationId, work, permission);
  }
}

export function createPlatform(options: PlatformOptions): Platform {
  return new Platform(options);
}
