import {
  EXPIRING_WINDOW_DAYS,
  requireOpaqueId,
  requireVersion,
} from '../../documents/src/index.js';

/**
 * Company settings (FLT-SETTINGS, first slice): the two parameters the base expiry alerts need,
 * the expiry window and the alert recipients (BRD §15.1, §15.3, FR-034, FR-150). One row per
 * company; a company that never saved settings reads the defaults at version 0. Catalogs, labels,
 * branding and quotas are later slices of the same lane.
 */

/** Role names a company can address alerts to. Mirrors the composition's role templates (checked by a test there). */
export const ALERT_RECIPIENT_ROLES = [
  'admin',
  'editor',
  'viewer',
  'auditor',
  'pii_reader',
] as const;
export type AlertRecipientRole = (typeof ALERT_RECIPIENT_ROLES)[number];
export const isAlertRecipientRole = (value: unknown): value is AlertRecipientRole =>
  typeof value === 'string' && (ALERT_RECIPIENT_ROLES as readonly string[]).includes(value);

/** The window can only narrow the fixed 30 days of the document and policy expiry helpers. */
export const MIN_EXPIRY_WINDOW_DAYS = 1;
export const MAX_EXPIRY_WINDOW_DAYS = EXPIRING_WINDOW_DAYS;
export const DEFAULT_EXPIRY_WINDOW_DAYS = EXPIRING_WINDOW_DAYS;
/** Default recipients: BRD §15.1 names the fleet manager (the editor template) and the administrator. */
export const DEFAULT_RECIPIENT_ROLES: readonly AlertRecipientRole[] = ['admin', 'editor'];

export type SettingsErrorCode = 'invalid_input' | 'stale_version';

export class SettingsError extends Error {
  public constructor(public readonly code: SettingsErrorCode) {
    super(`Settings request rejected: ${code}`);
    this.name = 'SettingsError';
  }
}

export interface CompanySettings {
  /** Company (tenant) that owns the row. Never taken from caller input. */
  readonly tenantId: string;
  /** Days before the last valid day in which a document or policy raises an alert (1 to 30). */
  readonly expiryWindowDays: number;
  /** Roles addressed by the alerts, in canonical order, without repeats. */
  readonly recipientRoles: readonly AlertRecipientRole[];
  /** Optimistic concurrency token: 0 while the company has never saved, then 1, +1 on every change. */
  readonly version: number;
  /** `user-<subject>` of the last writer; `null` for the defaults. */
  readonly updatedBy: string | null;
  readonly updatedAt: string | null;
}

const invalid = (): never => {
  throw new SettingsError('invalid_input');
};

const guardId = (value: unknown): string => {
  try {
    return requireOpaqueId(value);
  } catch {
    return invalid();
  }
};

const isInteger = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

export function defaultSettings(tenantId: string): CompanySettings {
  return {
    tenantId,
    expiryWindowDays: DEFAULT_EXPIRY_WINDOW_DAYS,
    recipientRoles: DEFAULT_RECIPIENT_ROLES,
    version: 0,
    updatedBy: null,
    updatedAt: null,
  };
}

export const SETTINGS_FIELDS = ['expiryWindowDays', 'recipientRoles'] as const;

export interface SettingsData {
  readonly expiryWindowDays: number;
  readonly recipientRoles: readonly AlertRecipientRole[];
}

/** Canonical order and no repeats, so equal sets are stored (and compared) identically. */
export const normalizeRoles = (roles: readonly AlertRecipientRole[]): AlertRecipientRole[] =>
  ALERT_RECIPIENT_ROLES.filter((role) => roles.includes(role));

/**
 * Validates a full replacement of the settings: both fields are required and unknown properties
 * are rejected. The recipients are a non-empty list of known roles without repeats.
 */
export function parseSettings(input: unknown): SettingsData {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return invalid();
  const fields = input as Readonly<Record<string, unknown>>;
  const keys = Object.keys(fields);
  if (
    keys.length !== SETTINGS_FIELDS.length ||
    keys.some((key) => !SETTINGS_FIELDS.includes(key as never))
  )
    return invalid();
  const days = fields['expiryWindowDays'];
  const roles = fields['recipientRoles'];
  if (!isInteger(days, MIN_EXPIRY_WINDOW_DAYS, MAX_EXPIRY_WINDOW_DAYS)) return invalid();
  if (
    !Array.isArray(roles) ||
    roles.length < 1 ||
    roles.length > ALERT_RECIPIENT_ROLES.length ||
    !roles.every(isAlertRecipientRole) ||
    new Set(roles).size !== roles.length
  )
    return invalid();
  return { expiryWindowDays: days, recipientRoles: normalizeRoles(roles) };
}

/** An expected version of 0 means "the company has not saved yet". */
export function parseExpectedVersion(value: unknown): number {
  return value === 0 ? 0 : requireVersionGuard(value);
}

function requireVersionGuard(value: unknown): number {
  try {
    return requireVersion(value);
  } catch {
    return invalid();
  }
}

// ---- store port -------------------------------------------------------------------------------

/**
 * Persistence port. Every method is tenant-scoped: the settings of another tenant are simply
 * absent. The store itself decides the race of two first writes: exactly one `insert` wins.
 */
export interface SettingsStore {
  find(tenantId: string): Promise<CompanySettings | null>;
  /** Writes the first settings of a company; false when the company already has a row. */
  insert(settings: CompanySettings): Promise<boolean>;
  /** Atomic compare-and-set: writes `next` only while the stored version is `expectedVersion`; false otherwise. */
  replace(next: CompanySettings, expectedVersion: number): Promise<boolean>;
}

/** In-memory double of the port. Each method is synchronous inside, so every operation is atomic. */
export class InMemorySettingsStore implements SettingsStore {
  private readonly rows = new Map<string, CompanySettings>();

  public async find(tenantId: string): Promise<CompanySettings | null> {
    const found = this.rows.get(tenantId);
    return found ? structuredClone(found) : null;
  }

  public async insert(settings: CompanySettings): Promise<boolean> {
    if (this.rows.has(settings.tenantId)) return false;
    this.rows.set(settings.tenantId, structuredClone(settings));
    return true;
  }

  public async replace(next: CompanySettings, expectedVersion: number): Promise<boolean> {
    if (this.rows.get(next.tenantId)?.version !== expectedVersion) return false;
    this.rows.set(next.tenantId, structuredClone(next));
    return true;
  }
}

// ---- service ----------------------------------------------------------------------------------

export interface SettingsServiceOptions {
  readonly now?: () => Date;
}

/**
 * Settings use cases over the store port. Authorization, authentication and audit belong to the
 * caller (the composition); this class enforces the domain rules. The tenant is always an argument
 * taken from the server-side session, never part of the input being validated.
 */
export class SettingsService {
  private readonly now: () => Date;

  public constructor(
    private readonly store: SettingsStore,
    options: SettingsServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  /** The stored settings of the tenant, or the defaults (version 0) when it never saved. */
  public async get(tenantId: string): Promise<CompanySettings> {
    const id = guardId(tenantId);
    const found = await this.store.find(id);
    return found?.tenantId === id ? found : defaultSettings(id);
  }

  /**
   * Replaces the settings. `expectedVersion` is the version of the last read (0 for the defaults);
   * a lost race, or a stale read, is `stale_version`.
   */
  public async update(
    tenantId: string,
    actorId: string,
    expectedVersion: unknown,
    input: unknown,
  ): Promise<CompanySettings> {
    guardId(tenantId);
    guardId(actorId);
    const now = this.now();
    const data = parseSettings(input);
    const version = parseExpectedVersion(expectedVersion);
    const next: CompanySettings = {
      tenantId,
      ...data,
      version: version + 1,
      updatedBy: actorId,
      updatedAt: now.toISOString(),
    };
    const written =
      version === 0 ? await this.store.insert(next) : await this.store.replace(next, version);
    if (!written) throw new SettingsError('stale_version');
    return next;
  }
}
