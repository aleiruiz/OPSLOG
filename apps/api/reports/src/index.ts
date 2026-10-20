import type { Permission } from '../../../../packages/domain/identity/src/index.js';
import type {
  Cell,
  ReportColumn,
  ReportEngine,
  ReportRequest,
  ReportSummary,
} from '../../../../packages/domain/reports/src/index.js';
import { ReportError } from '../../../../packages/domain/reports/src/index.js';
import {
  apiFailure,
  type ReportsApiResponse,
  type ReportsAuthorize,
} from '../../exports/src/failure.js';

export interface ReportsApiDeps {
  readonly authorize: ReportsAuthorize;
  readonly engine: Pick<ReportEngine, 'summaries' | 'plan' | 'context' | 'preview'>;
}

export interface ReportCatalogView {
  readonly reports: readonly ReportSummary[];
  /** The reader holds `export`. */
  readonly canExport: boolean;
}

export interface ReportPreviewView {
  readonly reportId: string;
  readonly columns: readonly ReportColumn[];
  readonly rows: readonly (readonly Cell[])[];
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
}

export const PREVIEW_MAX_LIMIT = 100;
export const PREVIEW_DEFAULT_LIMIT = 25;

/** Report catalog and paginated preview. Sensitive columns the reader may not see are never queried. */
export class ReportsApi {
  public constructor(private readonly deps: ReportsApiDeps) {}

  public async catalog(
    token: string,
    correlationId: string,
  ): Promise<ReportsApiResponse<ReportCatalogView>> {
    try {
      const session = await this.deps.authorize(token, correlationId);
      const permissions = new Set(session.permissions as readonly Permission[]);
      return {
        ok: true,
        value: {
          reports: this.deps.engine.summaries(permissions),
          canExport: permissions.has('export'),
        },
      };
    } catch (error) {
      return apiFailure(error);
    }
  }

  public async preview(
    token: string,
    correlationId: string,
    reportId: string,
    request: ReportRequest & { readonly limit?: number; readonly offset?: number },
  ): Promise<ReportsApiResponse<ReportPreviewView>> {
    try {
      const session = await this.deps.authorize(token, correlationId);
      const limit = request.limit ?? PREVIEW_DEFAULT_LIMIT;
      const offset = request.offset ?? 0;
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > PREVIEW_MAX_LIMIT ||
        !Number.isInteger(offset) ||
        offset < 0
      )
        throw new ReportError('invalid_input', 'limit');
      const permissions = new Set(session.permissions as readonly Permission[]);
      const plan = this.deps.engine.plan(reportId, permissions, request);
      const ctx = await this.deps.engine.context(session.tenantId, permissions, session.subject);
      const result = await this.deps.engine.preview(ctx, plan);
      return {
        ok: true,
        value: {
          reportId,
          columns: result.columns,
          rows: result.rows
            .slice(offset, offset + limit)
            .map((row) => result.columns.map((column) => row[column.id] ?? null)),
          total: result.total,
          offset,
          limit,
        },
      };
    } catch (error) {
      return apiFailure(error);
    }
  }
}
