import type { FileRecordStore } from '../../../../../packages/domain/files/src/index.js';
import type {
  IdentityStore,
  Permission,
  RecoveryNotifier,
} from '../../../../../packages/domain/identity/src/index.js';
import type { VehicleStore } from '../../../../../packages/domain/vehicles/src/index.js';
import type { EmployeeStore } from '../../../../../packages/domain/employees/src/index.js';
import type { DocumentStore } from '../../../../../packages/domain/documents/src/index.js';
import type { SettingsStore } from '../../../../../packages/domain/settings/src/index.js';
import type { AssignmentStore } from '../../../../../packages/domain/assignments/src/index.js';
import type { ImportStore } from '../../../../../packages/domain/imports/src/index.js';
import type { PolicyStore } from '../../../../../packages/domain/insurance/src/index.js';
import type { PlanStore } from '../../../../../packages/domain/maintenance/plans/src/index.js';
import type { WorkshopStore } from '../../../../../packages/domain/maintenance/workshops/src/index.js';
import type { MechanicStore } from '../../../../../packages/domain/maintenance/mechanics/src/index.js';
import type { IncidentStore } from '../../../../../packages/domain/incidents/cases/src/index.js';
import type { IncidentCostStore } from '../../../../../packages/domain/incidents/costs/src/index.js';
import type { IncidentRepairStore } from '../../../../../packages/domain/incidents/repairs/src/index.js';
import type { IncidentClosures } from '../../../../../packages/domain/incidents/workflow/src/index.js';
import type { IncidentChildStore } from '../../../../../packages/domain/incidents/third-parties/src/index.js';
import type { WorkOrderStore } from '../../../../../packages/domain/maintenance/orders/src/index.js';
import type {
  AlertAddresses,
  IncidentAlertMailer,
  IncidentSlaStore,
} from '../../../../../packages/domain/incidents/sla/src/index.js';
import type { ExportJobStore } from '../../../../../packages/domain/exports/src/index.js';
import type {
  NotificationEvents,
  NotificationStore,
} from '../../../../../packages/domain/notifications/src/index.js';
import type { WebhookStore } from '../../../../../packages/domain/webhooks/src/index.js';
import type {
  Resolver,
  SafeWebhookClient,
} from '../../../../../packages/platform/webhooks/src/index.js';
import type { MailPort } from '../../../../../packages/platform/mail/src/index.js';
import type {
  ReconcileQueue,
  SearchStore,
} from '../../../../../packages/domain/search/src/index.js';
import type { SavedViewStore } from '../../../../../packages/domain/saved-views/src/index.js';
import type { PiiCipher } from '../../../../../packages/platform/pii/src/index.js';
import type {
  AreaResourceCounter,
  AreaStore,
} from '../../../../../packages/domain/areas/src/index.js';
import type { AuditStore } from '../../../../../packages/platform/audit/src/index.js';
import type { OidcVerifier } from '../../../../../packages/platform/auth/src/index.js';
import type { OutboxStore } from '../../../../../packages/platform/outbox/src/index.js';
import type {
  ObjectStorage,
  FileSagaJournal,
  PipelineOptions,
  ScanQueue,
  VirusScanner,
} from '../../../../../packages/platform/files/src/index.js';
import type {
  DraftValues,
  MfaPolicy,
  RoleDirectoryStore,
  TenantSettingsStore,
} from '../directory.js';
import type { InMemoryTenantStore } from '../tenancy.js';

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
  /** Durable file lifecycle journal; production TypeORM file stores also implement this port. */
  readonly fileSagaJournal?: FileSagaJournal;
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
  /** Persistent import job store (the TypeORM adapter of `packages/persistence/imports`); in-memory by default. */
  readonly imports?: ImportStore;
  /** Persistent company settings store (the TypeORM adapter of `packages/persistence/settings`); in-memory by default. */
  readonly settings?: SettingsStore;
  readonly maintenancePlans?: PlanStore;
  readonly maintenanceWorkshops?: WorkshopStore;
  readonly maintenanceMechanics?: MechanicStore;
  readonly maintenanceOrders?: WorkOrderStore;
  /** Persistent incident store (the TypeORM adapter of `packages/persistence/incidents/cases`); in-memory by default. */
  readonly incidents?: IncidentStore;
  /**
   * Persistent third parties and evidence of the incidents (`packages/persistence/incidents/third-parties`),
   * written through `incidents`; in-memory by default. Both are persistent or neither is.
   */
  readonly incidentChildren?: IncidentChildStore;
  /** Persistent snapshots of closed cycles (`packages/persistence/incidents/workflow`), written with the case; in-memory by default. All three travel together. */
  readonly incidentClosures?: IncidentClosures;
  /** Persistent repair links and costs of the incidents (`packages/persistence/incidents/{repairs,costs}`), written with the case; in-memory by default. All five travel together. */
  readonly incidentRepairs?: IncidentRepairStore;
  readonly incidentCosts?: IncidentCostStore;
  /**
   * Persistent SLA of the incidents (`packages/persistence/incidents/sla`): cycles, notices and
   * deliveries; the notice and its outbox event commit together. In memory by default. It travels
   * with the five stores above.
   */
  readonly incidentSla?: IncidentSlaStore;
  /**
   * Persistent projection of the global search (`packages/persistence/search`), with the queue of
   * its reconcile jobs. In memory by default.
   */
  readonly search?: SearchStore & ReconcileQueue;
  /** Persistent saved views and visible columns (`packages/persistence/saved-views`). In memory by default. */
  readonly savedViews?: SavedViewStore;
  /** Persistent export jobs (`packages/persistence/exports`). In memory by default. */
  readonly exportJobs?: ExportJobStore;
  /** Persistent notification center (`packages/persistence/notifications`). In memory by default. */
  readonly notifications?: NotificationStore;
  /** Where the center writes the events no module publishes; the persistent store writes them in its own transaction. */
  readonly notificationEvents?: NotificationEvents;
  /**
   * The general mail port (ADR-0016): the SMTP adapter when its variables are set, otherwise the
   * sink. Without one, outside production, a sink that sends nothing. INC-SLA mails through it too.
   */
  readonly mail?: MailPort;
  /** Persistent webhooks (`packages/persistence/webhooks`). In memory by default. */
  readonly webhooks?: WebhookStore;
  /** The client that sends the signed POST; tests inject one. The default is the guarded HTTPS client. */
  readonly webhookClient?: Pick<SafeWebhookClient, 'send'>;
  /** DNS for the destination guard; tests inject one. The default is the system resolver. */
  readonly webhookResolver?: Resolver;
  /** The mail adapter of the SLA notices. Without one, outside production, a test sink records them. */
  readonly incidentAlertMailer?: IncidentAlertMailer;
  /** Where a member's address lives; read at send time. Defaults to a reserved, undeliverable address. */
  readonly incidentAlertAddresses?: AlertAddresses;
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
  /** Tenant-scoped durable audit relay; scheduled by the host worker. */
  readonly auditRelay?: { runBatch(max?: number): Promise<number> };
  readonly outbox?: OutboxStore;
  readonly tenants?: InMemoryTenantStore;
  /** Company name, MFA policy and idle hours; durable when the host injects a persistent store. */
  readonly tenantSettings?: TenantSettingsStore;
  readonly recoveryNotifier?: RecoveryNotifier;
}

export interface PlatformOptions {
  /** Server-side OIDC verifier (a synthetic one in tests; the real adapter is pending). */
  readonly verifier: OidcVerifier;
  readonly issuer: string;
  /** HMAC secret for download grants, at least 32 characters. */
  readonly grantSecret: string;
  readonly now?: () => Date;
  /** `production` requires a real mail adapter. Defaults to `OPSLOG_ENV`. */
  readonly environment?: string;
  readonly adapters?: PlatformAdapters;
  readonly pipeline?: Omit<PipelineOptions, 'now'>;
  readonly worker?: {
    readonly leaseMs?: number;
    readonly maxAttempts?: number;
    /** Cadence of the periodic incident SLA scan (default 15 minutes). */
    readonly slaScanIntervalMs?: number;
    /** Cadence of the periodic maintenance plan scan (default 1 hour). */
    readonly planScanIntervalMs?: number;
    /** Cadence of the periodic search projection reconcile (default 1 minute). */
    readonly searchReconcileIntervalMs?: number;
  };
  /** How long the scan runner holds back jobs of non-active tenants. */
  readonly scanHoldMs?: number;
  /** Public origin of the web app: the base of the links in e-mails. Relative links without it. */
  readonly publicOrigin?: string;
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

export interface EmitInput {
  /** Stable opaque id for idempotent re-publication (same id and content is deduplicated per tenant). */
  readonly eventId?: string;
  readonly type: string;
  readonly entityId: string;
  readonly payload: unknown;
  readonly idempotencyKey?: string;
}
export type Emit = (event: EmitInput) => void;
