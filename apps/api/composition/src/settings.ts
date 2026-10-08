import {
  SettingsError,
  type AlertRecipientRole,
  type CompanySettings,
  type SettingsService,
} from '../../../../packages/domain/settings/src/index.js';
import {
  AuthError,
  type Permission,
  type TenantContext,
} from '../../../../packages/domain/identity/src/index.js';
import type { PlatformResponse } from './platform.js';

export type CompanySettingsApiErrorCode =
  | 'invalid_input'
  | 'unauthorized'
  | 'forbidden'
  | 'stale_version'
  | 'internal_error';

const STATUS: Readonly<Record<CompanySettingsApiErrorCode, number>> = {
  invalid_input: 400,
  unauthorized: 401,
  forbidden: 403,
  stale_version: 409,
  internal_error: 500,
};

/**
 * Maps any failure to a safe payload: a code, its status and a generic message. Never a stack, an
 * SQL fragment or a value from the request: anything that is not a `SettingsError` or an
 * `AuthError` (including store errors) is a plain 500.
 */
function failure(error: unknown): PlatformResponse<never> {
  let code: CompanySettingsApiErrorCode = 'internal_error';
  if (error instanceof SettingsError) {
    code = error.code;
  } else if (error instanceof AuthError) {
    code =
      error.code === 'unauthorized' || error.code === 'expired'
        ? 'unauthorized'
        : error.code === 'forbidden'
          ? 'forbidden'
          : error.code === 'invalid_input'
            ? 'invalid_input'
            : 'internal_error';
  }
  return {
    ok: false,
    error: {
      code,
      status: STATUS[code],
      message: code === 'internal_error' ? 'Request failed' : `Settings request rejected: ${code}`,
    },
  };
}

/** What the browser may know about the company settings. The company is never part of it. */
export interface CompanySettingsView {
  readonly expiryWindowDays: number;
  readonly recipientRoles: readonly AlertRecipientRole[];
  /** 0 while the company has never saved (the values are then the defaults). */
  readonly version: number;
  readonly updatedBy: string | null;
  readonly updatedAt: string | null;
}

export type CompanySettingsAuditAction = 'company_settings.updated';

export interface CompanySettingsApiDeps {
  readonly service: SettingsService;
  /**
   * Authenticates the session (including the tenant gate), re-resolves the role and requires every
   * permission. The tenant and the actor of the returned context are the only ones ever used.
   */
  readonly authorize: (
    token: string,
    correlationId: string,
    required: readonly Permission[],
  ) => Promise<TenantContext>;
  /** Appends an audit event of the session's tenant and actor. Entity ids only, never field values. */
  readonly audit: (
    context: TenantContext,
    action: CompanySettingsAuditAction,
    entityId: string,
    correlationId: string,
  ) => void | Promise<void>;
}

/**
 * Permissions per operation. Reading the settings needs `view` (everyone who sees alerts may see
 * the window and the recipients); changing them needs `manage_config`, the configuration permission
 * of the administrator template (BRD S24).
 */
export const SETTINGS_PERMISSIONS = {
  read: ['view'],
  update: ['manage_config'],
} as const satisfies Record<string, readonly Permission[]>;

const viewOf = (settings: CompanySettings): CompanySettingsView => ({
  expiryWindowDays: settings.expiryWindowDays,
  recipientRoles: settings.recipientRoles,
  version: settings.version,
  updatedBy: settings.updatedBy,
  updatedAt: settings.updatedAt,
});

/**
 * Company settings use cases for the HTTP layer. Every call authenticates the session and
 * re-resolves the role (nothing is cached), takes the tenant only from that session, and audits
 * successful writes (action and company id only, never the values).
 */
export class CompanySettingsApi {
  public constructor(private readonly deps: CompanySettingsApiDeps) {}

  public async get(
    token: string,
    correlationId: string,
  ): Promise<PlatformResponse<CompanySettingsView>> {
    try {
      const context = await this.deps.authorize(token, correlationId, SETTINGS_PERMISSIONS.read);
      return { ok: true, value: viewOf(await this.deps.service.get(context.tenantId)) };
    } catch (error) {
      return failure(error);
    }
  }

  public async update(
    token: string,
    correlationId: string,
    version: unknown,
    input: unknown,
  ): Promise<PlatformResponse<CompanySettingsView>> {
    try {
      const context = await this.deps.authorize(token, correlationId, SETTINGS_PERMISSIONS.update);
      const saved = await this.deps.service.update(
        context.tenantId,
        `user-${context.actor.subject}`,
        version,
        input,
      );
      await this.deps.audit(context, 'company_settings.updated', context.tenantId, correlationId);
      return { ok: true, value: viewOf(saved) };
    } catch (error) {
      return failure(error);
    }
  }
}
