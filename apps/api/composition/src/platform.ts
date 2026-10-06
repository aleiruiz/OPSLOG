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
  InMemoryVehicleStore,
  VehicleError,
  VehicleService,
  type VehicleStore,
} from '../../../../packages/domain/vehicles/src/index.js';
import {
  EmployeeError,
  EmployeeService,
  InMemoryEmployeeStore,
  type EmployeeStore,
} from '../../../../packages/domain/employees/src/index.js';
import {
  DocumentError,
  DocumentService,
  InMemoryDocumentStore,
  type DocumentStore,
} from '../../../../packages/domain/documents/src/index.js';
import {
  InMemorySettingsStore,
  SettingsService,
  type SettingsStore,
} from '../../../../packages/domain/settings/src/index.js';
import { AlertService } from '../../../../packages/domain/alerts/src/index.js';
import {
  AssignmentError,
  AssignmentService,
  InMemoryAssignmentStore,
  type AssignmentStore,
} from '../../../../packages/domain/assignments/src/index.js';
import {
  PolicyError,
  PolicyService,
  InMemoryPolicyStore,
  type PolicyStore,
} from '../../../../packages/domain/insurance/src/index.js';
import {
  EnvelopePiiCipher,
  LocalDevKms,
  type PiiCipher,
} from '../../../../packages/platform/pii/src/index.js';
import {
  AreaService,
  InMemoryAreaStore,
  type AreaResourceCounter,
  type AreaStore,
} from '../../../../packages/domain/areas/src/index.js';
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
import {
  AccessDirectory,
  ROLE_PERMISSIONS,
  isRoleName,
  isStoredRoleReader,
  type RoleName,
} from './access.js';
import {
  DraftStore,
  MFA_POLICIES,
  ROLE_LABELS,
  RoleDirectory,
  TenantSettingsStore,
  isRoleDirectoryStore,
  type DraftValues,
  type MfaPolicy,
  type RoleDirectoryStore,
} from './directory.js';
import { InMemoryTenantStore } from './tenancy.js';
import { AreasApi } from './areas.js';
import { DocumentsApi } from './documents.js';
import { AssignmentsApi } from './assignments.js';
import { AlertsApi } from './alerts.js';
import { CompanySettingsApi } from './settings.js';
import { InsuranceApi } from './insurance.js';
import { EmployeesApi } from './employees.js';
import { VehiclesApi } from './vehicles.js';

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
  readonly error?: {
    readonly code: string;
    readonly status: number;
    readonly message: string;
    /** Only for a duplicate or an invalid area: the field (never its value). */
    readonly field?: string;
  };
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
    code =
      (error as { reason?: unknown }).reason === 'last_admin'
        ? 'last_admin'
        : error.code === 'expired'
          ? 'unauthorized'
          : error.code;
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
  /**
   * Persistent role directory (custom roles and membership roles). Defaults to the identity store
   * when that store implements it (the TypeORM adapter does); otherwise roles stay in memory.
   */
  readonly roleStore?: RoleDirectoryStore;
  readonly storage?: ObjectStorage;
  readonly scanner?: VirusScanner;
  readonly scanQueue?: ScanQueue;
  readonly records?: FileRecordStore;
  /** Persistent vehicle store (the TypeORM adapter of `packages/persistence/vehicles`); in-memory by default. */
  readonly vehicles?: VehicleStore;
  /** Persistent area store (the TypeORM adapter of `packages/persistence/areas`); in-memory by default. */
  readonly areas?: AreaStore;
  /** Persistent employee store (the TypeORM adapter of `packages/persistence/employees`); in-memory by default. */
  readonly employees?: EmployeeStore;
  /** Persistent document store (the TypeORM adapter of `packages/persistence/documents`); in-memory by default. */
  readonly documents?: DocumentStore;
  /** Persistent insurance policy store (the TypeORM adapter of `packages/persistence/insurance`); in-memory by default. */
  readonly insurance?: PolicyStore;
  /** Persistent vehicle assignment store (the TypeORM adapter of `packages/persistence/assignments`); in-memory by default. */
  readonly assignments?: AssignmentStore;
  /** Persistent company settings store (the TypeORM adapter of `packages/persistence/settings`); in-memory by default. */
  readonly settings?: SettingsStore;
  /**
   * Personal-data protection (SPECS D23): envelope encryption plus blind indexes. Defaults to the
   * local development KMS with a random per-process key, which refuses production-mode
   * configurations; a deployment with real data must inject a cipher over a real KMS adapter.
   */
  readonly pii?: PiiCipher;
  /**
   * Counter of the live people assigned to an area (BR-021). Defaults to the employee store's
   * `countLiveInArea`; injecting one is only for tests that need to hold the count.
   */
  readonly people?: AreaResourceCounter;
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

const ACTOR_PREFIX = 'user-';

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
  public readonly vehicles: VehiclesApi;
  public readonly areas: AreasApi;
  public readonly employees: EmployeesApi;
  public readonly documents: DocumentsApi;
  public readonly insurance: InsuranceApi;
  public readonly assignments: AssignmentsApi;
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
    const vehicleStore = adapters.vehicles ?? new InMemoryVehicleStore();
    // A persistent store with the throwaway local KMS would seal rows that cannot be opened after a
    // restart (and would put real data under a dev key): the cipher must be chosen explicitly.
    if (adapters.employees && !adapters.pii)
      throw new Error('adapters.employees requires adapters.pii (no local KMS fallback)');
    const employeeStore = adapters.employees ?? new InMemoryEmployeeStore();
    const areaService = new AreaService(adapters.areas ?? new InMemoryAreaStore(), {
      now: this.now,
      resources: {
        // BR-021: active vehicles are counted through the vehicles store port.
        vehicles: {
          countActive: (tenantId, areaId) => vehicleStore.countLiveInArea(tenantId, areaId),
        },
        // BR-021: live employees are counted through the employees store port.
        people: adapters.people ?? {
          countActive: (tenantId, areaId) => employeeStore.countLiveInArea(tenantId, areaId),
        },
      },
      // FR-041: a responsible user must be an active member of the tenant, per the directory.
      members: {
        isActiveMember: async (tenantId, userId) =>
          (await this.access.effectiveRole(tenantId, userId)) !== null,
      },
    });
    const vehicleService = new VehicleService(vehicleStore, {
      now: this.now,
      // BR-021 vs. TOCTOU: a vehicle write that sets or changes `areaId` runs under the same
      // per-tenant area lock as `AreaService.deactivate`, after checking the area is active.
      areas: {
        withActiveArea: async (tenantId, areaId, work) => {
          const outcome = await areaService.withActiveArea(tenantId, areaId, work);
          if (!outcome.active) throw new VehicleError('invalid_area', 'area_id');
          return outcome.value;
        },
      },
    });
    this.vehicles = new VehiclesApi({
      service: vehicleService,
      authorize: (token, correlationId, required) => this.authorize(token, correlationId, required),
      audit: (context, action, entityId, correlationId) =>
        this.auditNow(this.userActor(context), action, 'vehicle', entityId, correlationId),
    });
    const employeeService = new EmployeeService(employeeStore, {
      now: this.now,
      pii:
        adapters.pii ??
        new EnvelopePiiCipher(LocalDevKms.ephemeral(process.env['OPSLOG_ENV'] ?? 'development')),
      // BR-021 vs. TOCTOU: an employee write that sets or changes `areaId` runs under the same
      // per-tenant area lock as `AreaService.deactivate`, after checking the area is active.
      areas: {
        withActiveArea: async (tenantId, areaId, work) => {
          const outcome = await areaService.withActiveArea(tenantId, areaId, work);
          if (!outcome.active) throw new EmployeeError('invalid_area', 'area_id');
          return outcome.value;
        },
      },
    });
    this.employees = new EmployeesApi({
      service: employeeService,
      authorize: (token, correlationId, required) => this.authorize(token, correlationId, required),
      can: async (context, permission) =>
        (await this.access.resolvePermissions(context)).includes(permission),
      audit: (context, action, entityId, correlationId) =>
        this.auditNow(this.userActor(context), action, 'employee', entityId, correlationId),
    });
    const documentStore = adapters.documents ?? new InMemoryDocumentStore();
    const policyStore = adapters.insurance ?? new InMemoryPolicyStore();
    this.documents = new DocumentsApi({
      service: new DocumentService(documentStore, {
        now: this.now,
        // The owner of a document must be a live (not archived) vehicle or employee of the same
        // tenant. Unknown, foreign and archived owners are indistinguishable (no tenant oracle).
        owners: {
          assertLive: async (tenantId, ownerType, ownerId) => {
            const found = await (
              ownerType === 'vehicle'
                ? vehicleService.get(tenantId, ownerId)
                : employeeService.get(tenantId, ownerId)
            ).catch((error: unknown) => {
              if (
                (error instanceof VehicleError || error instanceof EmployeeError) &&
                error.code === 'not_found'
              )
                return null;
              throw error;
            });
            if (found === null || found.archivedAt !== null)
              throw new DocumentError('invalid_owner', 'owner_id');
          },
        },
      }),
      authorize: (token, correlationId, required) => this.authorize(token, correlationId, required),
      audit: (context, action, entityId, correlationId) =>
        this.auditNow(this.userActor(context), action, 'document', entityId, correlationId),
    });
    this.insurance = new InsuranceApi({
      service: new PolicyService(policyStore, {
        now: this.now,
        // The vehicle of a policy must be a live (not archived) vehicle of the same tenant.
        // Unknown, foreign and archived vehicles are indistinguishable (no tenant oracle).
        // Best effort (check, then act): see the task document.
        vehicles: {
          assertLive: async (tenantId, vehicleId) => {
            const found = await vehicleService.get(tenantId, vehicleId).catch((error: unknown) => {
              if (error instanceof VehicleError && error.code === 'not_found') return null;
              throw error;
            });
            if (found === null || found.archivedAt !== null)
              throw new PolicyError('invalid_vehicle', 'vehicle_id');
          },
        },
      }),
      authorize: (token, correlationId, required) => this.authorize(token, correlationId, required),
      can: async (context, permission) =>
        (await this.access.resolvePermissions(context)).includes(permission),
      audit: (context, action, entityId, correlationId) =>
        this.auditNow(this.userActor(context), action, 'insurance_policy', entityId, correlationId),
    });
    this.assignments = new AssignmentsApi({
      service: new AssignmentService(adapters.assignments ?? new InMemoryAssignmentStore(), {
        now: this.now,
        // BR-014: the vehicle must be live and neither inactive nor decommissioned, and the
        // employee a driver that is active and not archived, both of the same tenant. Unknown,
        // foreign and ineligible ones are indistinguishable (no tenant oracle). Best effort
        // (check, then act): see the task document.
        vehicles: {
          assertAssignable: async (tenantId, vehicleId) => {
            const found = await vehicleService.get(tenantId, vehicleId).catch((error: unknown) => {
              if (error instanceof VehicleError && error.code === 'not_found') return null;
              throw error;
            });
            if (
              found === null ||
              found.archivedAt !== null ||
              found.status === 'inactive' ||
              found.status === 'decommissioned'
            )
              throw new AssignmentError('invalid_vehicle', 'vehicle_id');
          },
        },
        employees: {
          assertAssignable: async (tenantId, employeeId) => {
            const found = await employeeService
              .get(tenantId, employeeId)
              .catch((error: unknown) => {
                if (error instanceof EmployeeError && error.code === 'not_found') return null;
                throw error;
              });
            if (
              found === null ||
              found.archivedAt !== null ||
              found.kind !== 'driver' ||
              found.status !== 'active'
            )
              throw new AssignmentError('invalid_employee', 'employee_id');
          },
        },
      }),
      authorize: (token, correlationId, required) => this.authorize(token, correlationId, required),
      audit: (context, action, entityId, correlationId) =>
        this.auditNow(
          this.userActor(context),
          action,
          'vehicle_assignment',
          entityId,
          correlationId,
        ),
    });
    const settingsService = new SettingsService(adapters.settings ?? new InMemorySettingsStore(), {
      now: this.now,
    });
    this.companySettings = new CompanySettingsApi({
      service: settingsService,
      authorize: (token, correlationId, required) => this.authorize(token, correlationId, required),
      audit: (context, action, entityId, correlationId) =>
        this.auditNow(this.userActor(context), action, 'company_settings', entityId, correlationId),
    });
    // Alerts are derived from the documents and policies stores on every read (no queue, no outbox
    // yet): vehicle documents and insurance policies whose last valid day falls inside the company's
    // window, or already passed. Archived ones are excluded; every read names the tenant.
    this.alerts = new AlertsApi({
      service: new AlertService(
        {
          vehicle_document: {
            due: async (tenantId, scope, window) => {
              const slice = await documentStore.list(
                tenantId,
                {
                  ownerType: 'vehicle',
                  includeArchived: false,
                  expiry: scope.expiry,
                  ...(scope.vehicleId === undefined ? {} : { ownerId: scope.vehicleId }),
                },
                window,
              );
              return {
                total: slice.total,
                items: slice.items.map((document) => ({
                  subjectId: document.id,
                  vehicleId: document.ownerId,
                  typeCode: document.typeCode,
                  dueOn: document.expiresOn as string,
                })),
              };
            },
          },
          insurance_policy: {
            due: async (tenantId, scope, window) => {
              const slice = await policyStore.list(
                tenantId,
                {
                  includeArchived: false,
                  expiry: scope.expiry,
                  ...(scope.vehicleId === undefined ? {} : { vehicleId: scope.vehicleId }),
                },
                window,
              );
              return {
                total: slice.total,
                items: slice.items.map((policy) => ({
                  subjectId: policy.id,
                  vehicleId: policy.vehicleId,
                  typeCode: policy.coverageType,
                  dueOn: policy.endsOn,
                })),
              };
            },
          },
        },
        {
          expiryWindowDays: async (tenantId) =>
            (await settingsService.get(tenantId)).expiryWindowDays,
        },
        { now: this.now },
      ),
      authorize: (token, correlationId, required) => this.authorize(token, correlationId, required),
    });
    this.areas = new AreasApi({
      service: areaService,
      authorize: (token, correlationId, required) => this.authorize(token, correlationId, required),
      audit: (context, action, entityId, correlationId) =>
        this.auditNow(this.userActor(context), action, 'area', entityId, correlationId),
    });
    this.runtime = createWorkerRuntime({
      outbox: this.outbox,
      tenants: this.tenants,
      actors: {
        // Current role, not the one at enqueue time: a revoked or demoted actor's pending jobs stop.
        allows: async (tenantId, actor, permission) => {
          if (!actor.subject.startsWith(ACTOR_PREFIX)) return false;
          const role = await this.access.effectiveRole(
            tenantId,
            actor.subject.slice(ACTOR_PREFIX.length),
          );
          if (!role) return false;
          return permission === undefined || ROLE_PERMISSIONS[role].includes(permission as never);
        },
      },
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
        // The persisted role is set while the membership is pending, so activation grants it directly.
        await this.persistRole(tenant.id, invitation.identityId, 'admin');
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
  public suspendTenant(tenantId: string): Promise<void> {
    return this.setStatus(tenantId, 'suspended', 'tenant.suspended');
  }

  public reactivateTenant(tenantId: string): Promise<void> {
    return this.setStatus(tenantId, 'active', 'tenant.reactivated');
  }

  /** Status changes take the tenant lock, so they never interleave with a redemption in flight. */
  private setStatus(tenantId: string, status: 'active' | 'suspended', action: string) {
    return this.locked(tenantId, async () => {
      await this.tenants.setTenantStatus(tenantId as TenantId, status);
      this.auditNow(
        { tenantId, actorId: 'system', actorKind: 'system' },
        action,
        'tenant',
        tenantId,
        `operator-${randomUUID()}`,
      );
    });
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
      await this.persistRole(context.tenantId, invitation.identityId, role);
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
      // Same gate as `inspectInvitation`: a suspended or failed tenant is frozen, so the redemption
      // fails with the uniform error before anything is consumed, activated or audited. The
      // invitation stays redeemable (until it expires) once the tenant is active again.
      const meta =
        typeof invitationToken === 'string'
          ? this.invitations.get(opaqueTokenGenerator.hash(invitationToken))
          : undefined;
      // Activation and directory update run under the tenant lock, like every other change of
      // membership, so a concurrent revocation of the same pending invitation cannot interleave.
      // An invitation unknown to the composition keeps the unlocked, fail-closed path below.
      return await (meta
        ? this.locked(meta.tenantId, () => this.redeem(invitationToken, principal, meta.tenantId))
        : this.redeem(invitationToken, principal, null));
    } catch (error) {
      return failure(error);
    }
  }

  private async redeem(
    invitationToken: string,
    principal: unknown,
    lockedTenantId: string | null,
  ): Promise<PlatformResponse<{ identityId: string; tenantId: string }>> {
    try {
      if (lockedTenantId !== null && this.tenants.status(lockedTenantId) !== 'active')
        throw new AuthError('unauthorized');
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

  /** Writes a membership role through to the persistent directory (no-op with in-memory adapters). */
  private async persistRole(tenantId: string, identityId: string, role: RoleName): Promise<void> {
    if (!(await this.roles.setMemberRole(tenantId, identityId, role)))
      throw new PlatformError('conflict');
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
      // Persisted first: the store enforces the last-administrator rule across processes and bumps
      // the persisted authorization version. The in-memory directory follows; if the rest of the
      // change fails, both writes are compensated so the directory and the store never disagree.
      await this.persistRole(context.tenantId, targetIdentityId, role);
      try {
        this.access.setRole(context.tenantId, targetIdentityId, role);
        await this.bumpProjection(context.tenantId, targetIdentityId, 'active');
      } catch (error) {
        this.access.setRole(context.tenantId, targetIdentityId, current);
        await this.persistRole(context.tenantId, targetIdentityId, current).catch(() => undefined);
        throw error;
      }
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
      if (!current) {
        if (!this.access.hasPending(targetIdentityId, context.tenantId))
          throw new PlatformError('not_found');
        // A pending invitation (of any role) is revoked: the token can no longer be redeemed. It
        // holds no active seat, so the last-administrator rule does not apply.
        try {
          await this.identity.revokeMembership(context.tenantId, targetIdentityId);
        } catch (error) {
          // The store already holds no live membership (revoked elsewhere): the directory entry
          // must still go, or the member would stay listed as "invited" forever.
          if (!(error instanceof AuthError && error.code === 'not_found')) throw error;
        }
        this.access.revokePending(targetIdentityId, context.tenantId);
        this.auditNow(
          this.userActor(context),
          'invitation.revoked',
          'membership',
          targetIdentityId,
          correlationId,
        );
        return null;
      }
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
      const role = await this.access.effectiveRole(context.tenantId, context.actor.subject);
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

  private async roleViews(tenantId: string): Promise<readonly RoleView[]> {
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
    const custom = (await this.roles.custom(tenantId)).map((role) => ({
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
      return success(await this.roleViews(context.tenantId));
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
      const source =
        typeof roleId === 'string' ? await this.roles.find(context.tenantId, roleId) : null;
      if (!source) throw new PlatformError('not_found');
      const trimmed = typeof name === 'string' ? name.trim() : '';
      if (!trimmed || trimmed.length > 80) throw new PlatformError('invalid_input');
      const role = { id: `custom-${randomUUID()}`, name: trimmed, permissions: source.permissions };
      if ((await this.roles.create(context.tenantId, role)) !== 'created')
        throw new PlatformError('conflict');
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
            actorRef: { subject: `${ACTOR_PREFIX}${context.actor.subject}`, kind: 'user' },
            requiredPermission: permission,
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
