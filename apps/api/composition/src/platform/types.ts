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
  PipelineOptions,
  ScanQueue,
  VirusScanner,
} from '../../../../../packages/platform/files/src/index.js';
import type { DraftValues, MfaPolicy, RoleDirectoryStore } from '../directory.js';
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

export interface EmitInput {
  /** Stable opaque id for idempotent re-publication (same id and content is deduplicated per tenant). */
  readonly eventId?: string;
  readonly type: string;
  readonly entityId: string;
  readonly payload: unknown;
  readonly idempotencyKey?: string;
}
export type Emit = (event: EmitInput) => void;
