import {
  ExportError,
  type ExportActor,
  type ExportDownload,
  type ExportJob,
  type ExportService,
} from '../../../../packages/domain/exports/src/index.js';
import type { Permission } from '../../../../packages/domain/identity/src/index.js';
import type { ReportFormat } from '../../../../packages/domain/reports/src/index.js';
import {
  apiFailure,
  type ReportsApiResponse,
  type ReportsAuthorize,
  type ReportsSession,
} from './failure.js';

export * from './failure.js';

export interface ExportsApiDeps {
  readonly authorize: ReportsAuthorize;
  readonly service: Pick<ExportService, 'request' | 'list' | 'get' | 'download'>;
}

export interface ExportsApiRequest {
  readonly reportId: string;
  readonly format: ReportFormat;
  readonly columns?: readonly string[];
  readonly filters?: Readonly<Record<string, string>>;
  readonly sort?: string;
  readonly direction?: 'asc' | 'desc';
  readonly idempotencyKey?: string;
}

export interface ExportsApiSlice {
  readonly items: readonly ExportJob[];
  readonly total: number;
}

const actorOf = (session: ReportsSession, correlationId: string): ExportActor => ({
  tenantId: session.tenantId,
  actorId: session.subject,
  sessionId: session.sessionId,
  permissions: new Set(session.permissions as readonly Permission[]),
  correlationId,
});

/**
 * Export endpoints. The company, the person and the grants come only from the session; a person
 * sees and downloads only their own exports.
 */
export class ExportsApi {
  public constructor(private readonly deps: ExportsApiDeps) {}

  private async run<T>(
    token: string,
    correlationId: string,
    action: (actor: ExportActor) => Promise<T>,
  ): Promise<ReportsApiResponse<T>> {
    try {
      const session = await this.deps.authorize(token, correlationId);
      return { ok: true, value: await action(actorOf(session, correlationId)) };
    } catch (error) {
      return apiFailure(error);
    }
  }

  public create(
    token: string,
    correlationId: string,
    input: ExportsApiRequest,
  ): Promise<ReportsApiResponse<{ readonly job: ExportJob; readonly replayed: boolean }>> {
    return this.run(token, correlationId, (actor) =>
      this.deps.service.request(actor, {
        reportId: input.reportId,
        format: input.format,
        ...(input.columns ? { columns: input.columns } : {}),
        ...(input.filters ? { filters: input.filters } : {}),
        ...(input.sort ? { sort: input.sort } : {}),
        ...(input.direction ? { direction: input.direction } : {}),
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      }),
    );
  }

  public list(
    token: string,
    correlationId: string,
    window: { readonly limit?: number; readonly offset?: number },
  ): Promise<ReportsApiResponse<ExportsApiSlice>> {
    return this.run(token, correlationId, (actor) => this.deps.service.list(actor, window));
  }

  public get(
    token: string,
    correlationId: string,
    id: string,
  ): Promise<ReportsApiResponse<ExportJob>> {
    return this.run(token, correlationId, (actor) => this.deps.service.get(actor, id));
  }

  /** The file, through the authenticated proxy: permissions are checked again and the read is audited. */
  public download(
    token: string,
    correlationId: string,
    id: string,
  ): Promise<ReportsApiResponse<ExportDownload>> {
    return this.run(token, correlationId, (actor) => this.deps.service.download(actor, id));
  }
}

export { ExportError };
