import {
  FileError,
  assertDownloadable,
  contentDispositionFor,
  requireOpaqueId,
  sha256Hex,
  type FileErrorCode,
  type FileRecord,
  type FileRecordStore,
  type FileStatus,
  type Sensitivity,
} from '../../../../packages/domain/files/src/index.js';
import {
  AuthError,
  type IdentityAccessResolver,
  type IdentityService,
  type Permission,
  type TenantContext,
} from '../../../../packages/domain/identity/src/index.js';
import type { AuditStore } from '../../../../packages/platform/audit/src/index.js';
import {
  DownloadGrants,
  FilePipeline,
  auditFileEvent,
  refFor,
  type DerivativeInput,
  type FileActor,
  type ObjectStorage,
} from '../../../../packages/platform/files/src/index.js';

export interface FilesResponse<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly error?: { readonly code: string; readonly status: number; readonly message: string };
}

const STATUS: Readonly<Record<FileErrorCode | 'internal_error', number>> = {
  invalid_input: 400,
  unsupported_type: 422,
  type_mismatch: 422,
  too_large: 422,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  not_available: 409,
  conflict: 409,
  integrity_failed: 500,
  storage_unavailable: 503,
  internal_error: 500,
};

/** Maps any failure to a safe payload: code and generic message only, no stack, key or content. */
function failure(error: unknown): FilesResponse<never> {
  let code: FileErrorCode | 'internal_error' = 'internal_error';
  if (error instanceof FileError) code = error.code;
  else if (error instanceof AuthError)
    code =
      error.code === 'unauthorized'
        ? 'unauthorized'
        : error.code === 'forbidden'
          ? 'forbidden'
          : 'invalid_input';
  return {
    ok: false,
    error: {
      code,
      status: STATUS[code],
      message: code === 'internal_error' ? 'Request failed' : `File request rejected: ${code}`,
    },
  };
}

export interface FileSummary {
  readonly id: string;
  readonly kind: 'original' | 'derivative';
  readonly status: FileStatus;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly displayName: string;
}

const summarize = (record: FileRecord): FileSummary => ({
  id: record.id,
  kind: record.kind,
  status: record.status,
  contentType: record.contentType,
  sizeBytes: record.sizeBytes,
  displayName: record.displayName,
});

export interface DownloadResult {
  readonly status: 200;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export interface FilesApiDeps {
  readonly records: FileRecordStore;
  readonly storage: ObjectStorage;
  readonly pipeline: FilePipeline;
  readonly grants: DownloadGrants;
  readonly audit: AuditStore;
  readonly now?: () => Date;
}

const UUID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;

interface Authorized {
  readonly context: TenantContext;
  readonly granted: readonly Permission[];
  readonly actor: FileActor;
}

/**
 * Files HTTP-facing API. Every call re-authenticates the session and re-resolves permissions
 * (no caching), so a revoked session or removed role blocks the next call, including proxy downloads.
 * The tenant always comes from the session context, never from caller input.
 */
export class FilesApi {
  private readonly now: () => Date;
  public constructor(
    private readonly identity: IdentityService,
    private readonly resolver: IdentityAccessResolver,
    private readonly deps: FilesApiDeps,
  ) {
    this.now = deps.now ?? (() => new Date());
  }

  private async authorize(
    token: string,
    correlationId: string,
    required: readonly Permission[],
  ): Promise<Authorized> {
    const context = await this.identity.authenticate(token, correlationId);
    const granted = await this.resolver.resolvePermissions(context);
    for (const permission of required)
      await this.identity.requirePermission(context, permission, granted);
    const subject = context.actor.subject;
    const actor: FileActor = {
      tenantId: context.tenantId,
      actorId: UUID.test(subject) ? `user-${subject}` : subject,
      actorKind: 'user',
      correlationId,
    };
    return { context, granted, actor };
  }

  public async upload(
    token: string,
    correlationId: string,
    input: { name: string; contentType: string; bytes: Uint8Array; sensitivity?: Sensitivity },
  ): Promise<FilesResponse<FileSummary>> {
    try {
      const sensitivity = input.sensitivity ?? 'standard';
      const required: Permission[] = sensitivity === 'pii' ? ['create', 'view_pii'] : ['create'];
      const { actor } = await this.authorize(token, correlationId, required);
      const record = await this.deps.pipeline.ingestOriginal(actor, {
        name: input.name,
        declaredType: input.contentType,
        bytes: input.bytes,
        sensitivity,
      });
      return { ok: true, value: summarize(record) };
    } catch (error) {
      return failure(error);
    }
  }

  public async createDerivative(
    token: string,
    correlationId: string,
    originalId: string,
    input: { contentType: string; bytes: Uint8Array; width: number; height: number },
  ): Promise<FilesResponse<FileSummary>> {
    try {
      const { actor } = await this.authorize(token, correlationId, ['edit']);
      const derivative: DerivativeInput = {
        declaredType: input.contentType,
        bytes: input.bytes,
        width: input.width,
        height: input.height,
      };
      const record = await this.deps.pipeline.ingestDerivative(actor, originalId, derivative);
      return { ok: true, value: summarize(record) };
    } catch (error) {
      return failure(error);
    }
  }

  /** Metadata including lifecycle status; never returns bytes. Other-tenant ids look absent. */
  public async status(
    token: string,
    correlationId: string,
    fileId: string,
  ): Promise<FilesResponse<FileSummary>> {
    try {
      const { context, granted } = await this.authorize(token, correlationId, ['view']);
      const record = await this.deps.records.get(context.tenantId, requireOpaqueId(fileId));
      if (!record) throw new FileError('not_found');
      if (record.sensitivity === 'pii' && !granted.includes('view_pii'))
        throw new FileError('forbidden');
      return { ok: true, value: summarize(record) };
    } catch (error) {
      return failure(error);
    }
  }

  /** Issues a short-lived grant only for a file that is downloadable right now. */
  public async createDownloadGrant(
    token: string,
    correlationId: string,
    fileId: string,
  ): Promise<FilesResponse<{ grant: string; expiresAt: string }>> {
    let auth: Authorized | undefined;
    try {
      auth = await this.authorize(token, correlationId, ['view']);
      await this.resolveDownloadable(auth, requireOpaqueId(fileId));
      const issued = this.deps.grants.issue({
        tenantId: auth.context.tenantId,
        fileId,
        subject: auth.context.actor.subject,
      });
      auditFileEvent(this.deps.audit, auth.actor, 'file.grant_issued', fileId, this.now());
      return {
        ok: true,
        value: { grant: issued.token, expiresAt: issued.expiresAt.toISOString() },
      };
    } catch (error) {
      this.auditDenied(auth, fileId, error);
      return failure(error);
    }
  }

  /**
   * Download proxy. Needs a live session and a grant issued to the same tenant and actor; checks
   * permissions, tenant, status and content integrity again, and audits before returning bytes.
   */
  public async download(
    token: string,
    correlationId: string,
    grantToken: string,
  ): Promise<FilesResponse<DownloadResult>> {
    let auth: Authorized | undefined;
    let fileId = '';
    try {
      auth = await this.authorize(token, correlationId, ['view']);
      const claims = this.deps.grants.verify(grantToken);
      fileId = claims.fileId;
      if (
        claims.tenantId !== auth.context.tenantId ||
        claims.subject !== auth.context.actor.subject
      )
        throw new FileError('forbidden');
      const record = await this.resolveDownloadable(auth, fileId);
      const bytes = await this.deps.storage.get(refFor(record, 'released'));
      if (!bytes) throw new FileError('not_found');
      if (sha256Hex(bytes) !== record.sha256) throw new FileError('integrity_failed');
      auditFileEvent(this.deps.audit, auth.actor, 'file.downloaded', record.id, this.now());
      return {
        ok: true,
        value: {
          status: 200,
          headers: {
            'Content-Type': record.contentType,
            'Content-Length': String(bytes.length),
            'Content-Disposition': contentDispositionFor(record.displayName),
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'private, no-store',
            'Content-Security-Policy': "default-src 'none'; sandbox",
          },
          body: bytes,
        },
      };
    } catch (error) {
      this.auditDenied(auth, fileId, error);
      return failure(error);
    }
  }

  private async resolveDownloadable(auth: Authorized, fileId: string): Promise<FileRecord> {
    const { tenantId } = auth.context;
    const record = await this.deps.records.get(tenantId, fileId);
    const original =
      record?.kind === 'derivative' && record.originalId !== undefined
        ? await this.deps.records.get(tenantId, record.originalId)
        : null;
    return assertDownloadable({ record, original, tenantId, granted: auth.granted });
  }

  /** Best effort: a denial is already returned to the caller, so an audit failure must not mask it. */
  private auditDenied(auth: Authorized | undefined, fileId: string, error: unknown): void {
    if (!auth || !(error instanceof FileError) || error.code === 'unauthorized') return;
    try {
      auditFileEvent(this.deps.audit, auth.actor, 'file.access_denied', fileId, this.now());
    } catch {
      /* the denial response stands */
    }
  }
}
