import 'reflect-metadata';
import type { DataSource } from 'typeorm';
import {
  isAlertRecipientRole,
  normalizeRoles,
  type CompanySettings,
  type SettingsStore,
} from '../../../domain/settings/src/index.js';
import { SETTINGS_RUNTIME_ACCOUNT } from './data-source.js';
import { SettingsEntity } from './entities.js';
import {
  SettingsStoreError,
  isDuplicateKey,
  sanitizeStoreError,
  type SettingsStoreErrorCode,
} from './errors.js';

/** Structured report of a failed operation (operation name, coarse code, driver errno). */
export interface StoreErrorEvent {
  readonly operation: string;
  readonly code: SettingsStoreErrorCode;
  readonly errno: number | null;
}

export interface TypeOrmSettingsStoreOptions {
  readonly onError?: (event: StoreErrorEvent) => void;
}

const integrity = (): never => {
  throw new SettingsStoreError('integrity');
};

/** A stored list is canonical (known roles, canonical order, no repeats) or the row is rejected. */
function rolesOf(value: string): CompanySettings['recipientRoles'] {
  const parts = value.split(',');
  const roles = parts.filter(isAlertRecipientRole);
  return roles.length === parts.length && normalizeRoles(roles).join() === value
    ? roles
    : integrity();
}

const toSettings = (row: SettingsEntity): CompanySettings => ({
  tenantId: row.tenantId,
  expiryWindowDays: row.expiryWindowDays,
  recipientRoles: rolesOf(row.recipientRoles),
  version: row.version,
  updatedBy: row.updatedBy,
  updatedAt: row.updatedAt.toISOString(),
});

/** Columns that can change after creation (never the tenant). */
const mutableColumns = (settings: CompanySettings) => ({
  expiryWindowDays: settings.expiryWindowDays,
  recipientRoles: settings.recipientRoles.join(','),
  version: settings.version,
  updatedBy: settings.updatedBy as string,
  updatedAt: new Date(settings.updatedAt as string),
});

/**
 * Persistent TypeORM/MySQL implementation of the `SettingsStore` port.
 *
 * - Every statement names `company_id`, the primary key, so a row of another company is
 *   unreachable, not merely hidden.
 * - The race of two first writes is the primary key: exactly one INSERT wins, the other reads as
 *   `false` (a stale version for the service).
 * - Concurrency is optimistic: a replacement is a single conditional UPDATE on
 *   `(company_id, version)`.
 * - Driver errors never leave this class: everything becomes the sanitized `SettingsStoreError`
 *   (no SQL, no parameters).
 */
export class TypeOrmSettingsStore implements SettingsStore {
  private readonly onError: ((event: StoreErrorEvent) => void) | undefined;

  public constructor(
    private readonly dataSource: DataSource,
    options: TypeOrmSettingsStoreOptions = {},
  ) {
    if (dataSource.options.type !== 'mysql' || dataSource.options.synchronize === true)
      throw new Error('Settings store requires MySQL with synchronize disabled');
    const username = dataSource.options.username;
    if (typeof username !== 'string' || !SETTINGS_RUNTIME_ACCOUNT.test(username))
      throw new Error('Settings store requires its restricted runtime account');
    this.onError = options.onError;
  }

  private fail(operation: string, error: unknown): Error {
    const safe = sanitizeStoreError(error);
    if (safe instanceof SettingsStoreError)
      this.onError?.({ operation, code: safe.code, errno: safe.errno });
    return safe;
  }

  public async find(tenantId: string): Promise<CompanySettings | null> {
    try {
      const row = await this.dataSource.getRepository(SettingsEntity).findOneBy({ tenantId });
      return row ? toSettings(row) : null;
    } catch (error) {
      throw this.fail('find', error);
    }
  }

  public async insert(settings: CompanySettings): Promise<boolean> {
    try {
      await this.dataSource
        .getRepository(SettingsEntity)
        .insert({ tenantId: settings.tenantId, ...mutableColumns(settings) });
      return true;
    } catch (error) {
      if (isDuplicateKey(error)) return false;
      throw this.fail('insert', error);
    }
  }

  public async replace(next: CompanySettings, expectedVersion: number): Promise<boolean> {
    try {
      const result = await this.dataSource
        .getRepository(SettingsEntity)
        .update({ tenantId: next.tenantId, version: expectedVersion }, mutableColumns(next));
      return result.affected === 1;
    } catch (error) {
      throw this.fail('replace', error);
    }
  }
}
