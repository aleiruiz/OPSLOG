import {
  AuditQueryError,
  type AuditEntryPage,
  type AuditQueryInput,
  type AuditQueryService,
  type AuditReconciliation,
  type AuditViewer,
} from '../../../../packages/domain/audit-query/src/index.js';
import {
  AuthError,
  type Permission,
  type TenantContext,
} from '../../../../packages/domain/identity/src/index.js';

export type AuditApiErrorCode =
  | 'invalid_input'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'internal_error';

export interface AuditApiResponse<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly error?: { readonly code: string; readonly status: number; readonly message: string };
}

const STATUS: Readonly<Record<AuditApiErrorCode, number>> = {
  invalid_input: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  internal_error: 500,
};

/** Maps any failure to a safe payload: a code, its status and a fixed message. Store errors are a plain 500. */
function failure(error: unknown): AuditApiResponse<never> {
  let code: AuditApiErrorCode = 'internal_error';
  if (error instanceof AuditQueryError) code = error.code;
  else if (error instanceof AuthError)
    code =
      error.code === 'unauthorized' || error.code === 'expired'
        ? 'unauthorized'
        : error.code === 'forbidden'
          ? 'forbidden'
          : error.code === 'invalid_input' || error.code === 'not_found'
            ? error.code
            : 'internal_error';
  return {
    ok: false,
    error: {
      code,
      status: STATUS[code],
      message: code === 'internal_error' ? 'Request failed' : `Audit request rejected: ${code}`,
    },
  };
}

export interface AuditQueryApiDeps {
  readonly service: AuditQueryService;
  /**
   * Authenticates the session (tenant gate included), re-resolves the role and requires `view_audit`. Returns the
   * context and every permission the role grants: the tenant of the context is the only one ever used.
   */
  readonly authorize: (
    token: string,
    correlationId: string,
  ) => Promise<{ readonly context: TenantContext; readonly permissions: readonly Permission[] }>;
}

export type AuditPageView = AuditEntryPage & { readonly tenantId: string };
export type AuditReconciliationView = AuditReconciliation;

/**
 * Audit reads for the HTTP layer (FR-171, S26). Every call authenticates the session and re-resolves the role
 * (nothing is cached); the company comes only from that session. Nothing is written.
 */
export class AuditQueryApi {
  public constructor(private readonly deps: AuditQueryApiDeps) {}

  public async list(
    token: string,
    correlationId: string,
    input: AuditQueryInput,
  ): Promise<AuditApiResponse<AuditPageView>> {
    try {
      const { context, permissions } = await this.deps.authorize(token, correlationId);
      const page = await this.deps.service.list(context.tenantId, viewer(permissions), input);
      return { ok: true, value: { ...page, tenantId: context.tenantId } };
    } catch (error) {
      return failure(error);
    }
  }

  public async forEntity(
    token: string,
    correlationId: string,
    entityType: string,
    entityId: string,
    input: Omit<AuditQueryInput, 'entityType' | 'entityId' | 'actorId'>,
  ): Promise<AuditApiResponse<AuditPageView>> {
    try {
      const { context, permissions } = await this.deps.authorize(token, correlationId);
      const page = await this.deps.service.forEntity(
        context.tenantId,
        viewer(permissions),
        entityType,
        entityId,
        input,
      );
      return { ok: true, value: { ...page, tenantId: context.tenantId } };
    } catch (error) {
      return failure(error);
    }
  }

  public async reconciliation(
    token: string,
    correlationId: string,
    input: { readonly from?: string; readonly to?: string },
  ): Promise<AuditApiResponse<AuditReconciliationView>> {
    try {
      const { context } = await this.deps.authorize(token, correlationId);
      return { ok: true, value: await this.deps.service.reconciliation(context.tenantId, input) };
    } catch (error) {
      return failure(error);
    }
  }
}

const viewer = (permissions: readonly Permission[]): AuditViewer => ({ permissions });
