import {
  ImportError,
  importWritesPii,
  type ImportEntity,
  type ImportEvent,
  type ImportHistoryQuery,
  type ImportJob,
  type ImportListQuery,
  type ImportRowResult,
  type ImportRowsQuery,
  type ImportService,
} from '../../../../packages/domain/imports/src/index.js';
import {
  AuthError,
  type Permission,
  type TenantContext,
} from '../../../../packages/domain/identity/src/index.js';
import type { PlatformResponse } from './platform.js';

export type ImportsApiErrorCode =
  | 'invalid_input'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'internal_error';

const STATUS: Readonly<Record<ImportsApiErrorCode, number>> = {
  invalid_input: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  internal_error: 500,
};

/**
 * Maps any failure to a safe payload: a code, its status and a generic message. Never a stack, an
 * SQL fragment, a KMS or cipher message, or a value from the request: anything that is not an
 * `ImportError` or an `AuthError` (including the errors of the entity services and the stores) is a
 * plain 500, so an imported value can never come back through an error.
 */
function failure(error: unknown): PlatformResponse<never> {
  let code: ImportsApiErrorCode = 'internal_error';
  if (error instanceof ImportError) code = error.code;
  else if (error instanceof AuthError)
    code =
      error.code === 'unauthorized' || error.code === 'expired'
        ? 'unauthorized'
        : error.code === 'forbidden'
          ? 'forbidden'
          : error.code === 'invalid_input'
            ? 'invalid_input'
            : 'internal_error';
  return {
    ok: false,
    error: {
      code,
      status: STATUS[code],
      message: code === 'internal_error' ? 'Request failed' : `Import request rejected: ${code}`,
    },
  };
}

/** What the browser may know about an import job: counts and states. The company, the key and the fingerprint never leave. */
export interface ImportJobView {
  readonly id: string;
  readonly entity: ImportJob['entity'];
  readonly mode: ImportJob['mode'];
  readonly status: ImportJob['status'];
  readonly totalRows: number;
  readonly validRows: number;
  readonly invalidRows: number;
  readonly importedRows: number;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly finishedAt: string | null;
  readonly version: number;
}

export interface ImportSubmittedView {
  readonly job: ImportJobView;
  readonly replayed: boolean;
}

export interface ImportRowView {
  readonly rowNumber: number;
  readonly outcome: ImportRowResult['outcome'];
  readonly code: ImportRowResult['code'];
  readonly columns: readonly string[];
  readonly entityId: string | null;
  readonly at: string;
}

export interface ImportEventView {
  readonly seq: number;
  readonly kind: ImportEvent['kind'];
  readonly actorId: string;
  readonly acceptedRows: number | null;
  readonly rejectedRows: number | null;
  readonly at: string;
}

export interface ImportListView {
  readonly items: readonly ImportJobView[];
  readonly total: number;
}
export interface ImportRowsView {
  readonly items: readonly ImportRowView[];
  readonly total: number;
}
export interface ImportHistoryView {
  readonly items: readonly ImportEventView[];
  readonly total: number;
}

/** The import job, and every vehicle or employee it creates, are audited by id and action only. */
export type ImportsAuditAction = 'import_job.created' | 'vehicle.created' | 'employee.created';
export type ImportsAuditEntity = 'import_job' | ImportEntity;

export interface ImportsApiDeps {
  readonly service: ImportService;
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
    action: ImportsAuditAction,
    entityType: ImportsAuditEntity,
    entityId: string,
    correlationId: string,
  ) => void;
}

/**
 * Permissions per operation. The platform has no module-scoped permissions yet (open question in
 * the task document), so the generic ones are used: reading jobs needs `view`; importing needs the
 * `create` permission of the entity being created (the same one its own create route asks for), and
 * employee rows that carry personal data add `view_pii`, exactly as creating such an employee does.
 * Jobs are never edited or deleted.
 */
export const IMPORT_PERMISSIONS = {
  read: ['view'],
  create: ['create'],
  pii: ['view_pii'],
} as const satisfies Record<string, readonly Permission[]>;

const viewOf = (job: ImportJob): ImportJobView => ({
  id: job.id,
  entity: job.entity,
  mode: job.mode,
  status: job.status,
  totalRows: job.totalRows,
  validRows: job.validRows,
  invalidRows: job.invalidRows,
  importedRows: job.importedRows,
  createdBy: job.createdBy,
  createdAt: job.createdAt,
  finishedAt: job.finishedAt,
  version: job.version,
});

/**
 * Import use cases for the HTTP layer. Every call authenticates the session and re-resolves the
 * role (nothing is cached), takes the tenant only from that session and audits the job and every
 * record it creates (ids and actions only). The entity rules (unique keys per tenant, active area,
 * encryption of personal data) are enforced by the vehicle and employee services the import runs
 * through; nothing a row carried is kept in a job, a result, an audit event or a response.
 */
export class ImportsApi {
  public constructor(private readonly deps: ImportsApiDeps) {}

  private actorOf = (context: TenantContext): string => `user-${context.actor.subject}`;

  /** The create permission of the entity, plus the PII one for rows with personal data (a malformed request needs only the base: the service then rejects it). */
  private permissionsFor(input: unknown): readonly Permission[] {
    return importWritesPii(input)
      ? [...IMPORT_PERMISSIONS.create, ...IMPORT_PERMISSIONS.pii]
      : IMPORT_PERMISSIONS.create;
  }

  public async submit(
    token: string,
    correlationId: string,
    input: unknown,
  ): Promise<PlatformResponse<ImportSubmittedView>> {
    try {
      const context = await this.deps.authorize(token, correlationId, this.permissionsFor(input));
      const { job, replayed } = await this.deps.service.submit(
        context.tenantId,
        this.actorOf(context),
        input,
        {
          created: (entity, id) =>
            this.deps.audit(context, `${entity}.created`, entity, id, correlationId),
        },
      );
      if (!replayed)
        this.deps.audit(context, 'import_job.created', 'import_job', job.id, correlationId);
      return { ok: true, value: { job: viewOf(job), replayed } };
    } catch (error) {
      return failure(error);
    }
  }

  public async get(
    token: string,
    correlationId: string,
    id: unknown,
  ): Promise<PlatformResponse<ImportJobView>> {
    try {
      const context = await this.deps.authorize(token, correlationId, IMPORT_PERMISSIONS.read);
      return { ok: true, value: viewOf(await this.deps.service.get(context.tenantId, id)) };
    } catch (error) {
      return failure(error);
    }
  }

  public async list(
    token: string,
    correlationId: string,
    query: ImportListQuery,
  ): Promise<PlatformResponse<ImportListView & { tenantId: string }>> {
    try {
      const context = await this.deps.authorize(token, correlationId, IMPORT_PERMISSIONS.read);
      const slice = await this.deps.service.list(context.tenantId, query);
      return {
        ok: true,
        value: {
          tenantId: context.tenantId,
          items: slice.items.map(viewOf),
          total: slice.total,
        },
      };
    } catch (error) {
      return failure(error);
    }
  }

  /** The per-row report (`outcome: 'invalid'` lists the errors with row, columns and reason). */
  public async rows(
    token: string,
    correlationId: string,
    id: unknown,
    query: ImportRowsQuery,
  ): Promise<PlatformResponse<ImportRowsView & { tenantId: string }>> {
    try {
      const context = await this.deps.authorize(token, correlationId, IMPORT_PERMISSIONS.read);
      const slice = await this.deps.service.rows(context.tenantId, id, query);
      return {
        ok: true,
        value: {
          tenantId: context.tenantId,
          total: slice.total,
          items: slice.items.map(
            (row): ImportRowView => ({
              rowNumber: row.rowNumber,
              outcome: row.outcome,
              code: row.code,
              columns: row.columns,
              entityId: row.entityId,
              at: row.at,
            }),
          ),
        },
      };
    } catch (error) {
      return failure(error);
    }
  }

  public async history(
    token: string,
    correlationId: string,
    id: unknown,
    query: ImportHistoryQuery,
  ): Promise<PlatformResponse<ImportHistoryView & { tenantId: string }>> {
    try {
      const context = await this.deps.authorize(token, correlationId, IMPORT_PERMISSIONS.read);
      const slice = await this.deps.service.history(context.tenantId, id, query);
      return {
        ok: true,
        value: {
          tenantId: context.tenantId,
          total: slice.total,
          items: slice.items.map(
            (event): ImportEventView => ({
              seq: event.seq,
              kind: event.kind,
              actorId: event.actorId,
              acceptedRows: event.acceptedRows,
              rejectedRows: event.rejectedRows,
              at: event.at,
            }),
          ),
        },
      };
    } catch (error) {
      return failure(error);
    }
  }
}
