import {
  DocumentError,
  type Document,
  type DocumentHistoryQuery,
  type DocumentListQuery,
  type DocumentRevision,
  type DocumentService,
  type DocumentStatus,
  type RevisionStatus,
} from '../../../../packages/domain/documents/src/index.js';
import {
  AuthError,
  type Permission,
  type TenantContext,
} from '../../../../packages/domain/identity/src/index.js';
import type { PlatformResponse } from './platform.js';

export type DocumentApiErrorCode =
  | 'invalid_input'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'stale_version'
  | 'immutable'
  | 'invalid_owner'
  | 'internal_error';

const STATUS: Readonly<Record<DocumentApiErrorCode, number>> = {
  invalid_input: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  stale_version: 409,
  immutable: 409,
  invalid_owner: 422,
  internal_error: 500,
};

/**
 * Maps any failure to a safe payload: a code, its status, a generic message and, for an invalid
 * owner, the name of the field (`owner_id`). Never a stack, an SQL fragment or a value from the
 * request: anything that is not a `DocumentError` or an `AuthError` (including store errors) is a
 * plain 500.
 */
function failure(error: unknown): PlatformResponse<never> {
  let code: DocumentApiErrorCode = 'internal_error';
  let field: string | undefined;
  if (error instanceof DocumentError) {
    code = error.code;
    field = error.field;
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
      message: code === 'internal_error' ? 'Request failed' : `Document request rejected: ${code}`,
      ...(field === undefined ? {} : { field }),
    },
  };
}

/** What the browser may know about a document. The company is never part of it. */
export interface DocumentView {
  readonly id: string;
  readonly ownerType: Document['ownerType'];
  readonly ownerId: string;
  readonly typeCode: string;
  readonly title: string;
  readonly notes: string | null;
  readonly revision: number;
  readonly issuedOn: string | null;
  readonly expiresOn: string | null;
  readonly documentNumber: string | null;
  /** Derived from the expiry date and the service clock; never stored. */
  readonly status: DocumentStatus;
  /** Whole days to the last valid day (negative once expired); `null` without expiry. */
  readonly daysToExpiry: number | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

export interface DocumentRevisionView {
  readonly revision: number;
  readonly issuedOn: string | null;
  readonly expiresOn: string | null;
  readonly documentNumber: string | null;
  readonly status: RevisionStatus;
  readonly actorId: string;
  readonly at: string;
}

export interface DocumentListView {
  readonly items: readonly DocumentView[];
  readonly total: number;
}

export interface DocumentHistoryView {
  readonly items: readonly DocumentRevisionView[];
  readonly total: number;
}

/** Field by field: nothing is spread from the domain object, so a new internal field never leaks. */
const viewOf = (
  document: Document,
  expiry: { status: DocumentStatus; daysToExpiry: number | null },
): DocumentView => ({
  id: document.id,
  ownerType: document.ownerType,
  ownerId: document.ownerId,
  typeCode: document.typeCode,
  title: document.title,
  notes: document.notes,
  revision: document.revision,
  issuedOn: document.issuedOn,
  expiresOn: document.expiresOn,
  documentNumber: document.documentNumber,
  status: expiry.status,
  daysToExpiry: expiry.daysToExpiry,
  version: document.version,
  createdAt: document.createdAt,
  updatedAt: document.updatedAt,
  archivedAt: document.archivedAt,
});

export type DocumentAuditAction =
  | 'document.created'
  | 'document.updated'
  | 'document.renewed'
  | 'document.archived';

export interface DocumentsApiDeps {
  readonly service: DocumentService;
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
    action: DocumentAuditAction,
    entityId: string,
    correlationId: string,
  ) => void;
}

/**
 * Permissions per operation. The platform has no module-scoped permissions yet (open question in
 * the task document), so the generic ones are used: reading needs `view`, creating `create`,
 * every change of an existing document (edit, renewal) `edit`, and archiving (soft delete)
 * `delete`.
 */
export const DOCUMENT_PERMISSIONS = {
  read: ['view'],
  create: ['create'],
  change: ['edit'],
  archive: ['delete'],
} as const satisfies Record<string, readonly Permission[]>;

/**
 * Documents use cases for the HTTP layer. Every call authenticates the session and re-resolves the
 * role (nothing is cached), takes the tenant only from that session, and audits successful writes
 * (ids and actions only). The one cross-module rule, that the owner is a live vehicle or employee
 * of the tenant, is enforced by the service through the owner gate wired in `platform.ts`.
 */
export class DocumentsApi {
  public constructor(private readonly deps: DocumentsApiDeps) {}

  private async write(
    token: string,
    correlationId: string,
    permissions: readonly Permission[],
    action: DocumentAuditAction,
    work: (context: TenantContext) => Promise<Document>,
  ): Promise<PlatformResponse<DocumentView>> {
    try {
      const context = await this.deps.authorize(token, correlationId, permissions);
      const document = await work(context);
      this.deps.audit(context, action, document.id, correlationId);
      return { ok: true, value: viewOf(document, this.deps.service.expiry(document)) };
    } catch (error) {
      return failure(error);
    }
  }

  private actorOf = (context: TenantContext): string => `user-${context.actor.subject}`;

  public create(
    token: string,
    correlationId: string,
    input: unknown,
  ): Promise<PlatformResponse<DocumentView>> {
    return this.write(token, correlationId, DOCUMENT_PERMISSIONS.create, 'document.created', (c) =>
      this.deps.service.create(c.tenantId, this.actorOf(c), input),
    );
  }

  public update(
    token: string,
    correlationId: string,
    id: unknown,
    version: unknown,
    patch: unknown,
  ): Promise<PlatformResponse<DocumentView>> {
    return this.write(token, correlationId, DOCUMENT_PERMISSIONS.change, 'document.updated', (c) =>
      this.deps.service.update(c.tenantId, id, version, patch),
    );
  }

  public renew(
    token: string,
    correlationId: string,
    id: unknown,
    version: unknown,
    input: unknown,
  ): Promise<PlatformResponse<DocumentView>> {
    return this.write(token, correlationId, DOCUMENT_PERMISSIONS.change, 'document.renewed', (c) =>
      this.deps.service.renew(c.tenantId, this.actorOf(c), id, version, input),
    );
  }

  public archive(
    token: string,
    correlationId: string,
    id: unknown,
    version: unknown,
  ): Promise<PlatformResponse<DocumentView>> {
    return this.write(
      token,
      correlationId,
      DOCUMENT_PERMISSIONS.archive,
      'document.archived',
      (c) => this.deps.service.archive(c.tenantId, id, version),
    );
  }

  public async get(
    token: string,
    correlationId: string,
    id: unknown,
  ): Promise<PlatformResponse<DocumentView>> {
    try {
      const context = await this.deps.authorize(token, correlationId, DOCUMENT_PERMISSIONS.read);
      const document = await this.deps.service.get(context.tenantId, id);
      return { ok: true, value: viewOf(document, this.deps.service.expiry(document)) };
    } catch (error) {
      return failure(error);
    }
  }

  public async list(
    token: string,
    correlationId: string,
    query: DocumentListQuery,
  ): Promise<PlatformResponse<DocumentListView & { tenantId: string }>> {
    try {
      const context = await this.deps.authorize(token, correlationId, DOCUMENT_PERMISSIONS.read);
      const slice = await this.deps.service.list(context.tenantId, query);
      return {
        ok: true,
        value: {
          tenantId: context.tenantId,
          items: slice.items.map((document) =>
            viewOf(document, this.deps.service.expiry(document)),
          ),
          total: slice.total,
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
    query: DocumentHistoryQuery,
  ): Promise<PlatformResponse<DocumentHistoryView & { tenantId: string }>> {
    try {
      const context = await this.deps.authorize(token, correlationId, DOCUMENT_PERMISSIONS.read);
      const slice = await this.deps.service.history(context.tenantId, id, query);
      return {
        ok: true,
        value: {
          tenantId: context.tenantId,
          total: slice.total,
          items: slice.items.map(
            (row: DocumentRevision & { status: RevisionStatus }): DocumentRevisionView => ({
              revision: row.revision,
              issuedOn: row.issuedOn,
              expiresOn: row.expiresOn,
              documentNumber: row.documentNumber,
              status: row.status,
              actorId: row.actorId,
              at: row.at,
            }),
          ),
        },
      };
    } catch (error) {
      return failure(error);
    }
  }
}
