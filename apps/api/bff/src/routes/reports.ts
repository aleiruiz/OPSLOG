import {
  BFF_REPORT_FORMATS,
  BFF_REPORT_RESERVED_QUERY,
  IDEMPOTENCY_KEY_HEADER,
  isIdempotencyKey,
  type BffExport,
  type BffExportInput,
  type BffReportCatalog,
  type BffReportFormat,
  type BffReportPreview,
} from '../../../../../packages/contracts/src/index.js';
import type { ExportJob } from '../../../../../packages/domain/exports/src/index.js';
import { REPORT_FAMILIES } from '../../../../../packages/domain/reports/src/index.js';
import { fileResponse, singleHeader, type BffResponse } from '../http.js';
import { body, bad, failure, ID, route, success, type Route, type RouteContext } from './shared.js';

/** Column, filter and sort ids: letters and digits, as the catalog defines them. */
const NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const COUNT = /^\d{1,7}$/;
const MAX_COLUMNS = 40;
const MAX_FILTERS = 20;
const MAX_VALUE = 120;
const RESERVED: readonly string[] = BFF_REPORT_RESERVED_QUERY;

const isFormat = (value: unknown): value is BffReportFormat =>
  (BFF_REPORT_FORMATS as readonly unknown[]).includes(value);

interface Request {
  columns?: string[];
  filters?: Record<string, string>;
  sort?: string;
  direction?: 'asc' | 'desc';
}

function columnList(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_COLUMNS) return null;
  return raw.every((item) => typeof item === 'string' && NAME.test(item)) ? [...raw] : null;
}

function filterMap(raw: unknown): Record<string, string> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const entries = Object.entries(raw);
  if (entries.length > MAX_FILTERS) return null;
  for (const [name, value] of entries)
    if (!NAME.test(name) || typeof value !== 'string' || value.length > MAX_VALUE) return null;
  return Object.fromEntries(entries) as Record<string, string>;
}

/** Strict preview query: reserved names once each, every other name is a filter of the report. */
function previewQuery(ctx: RouteContext) {
  const keys = [...ctx.query.keys()];
  if (new Set(keys).size !== keys.length) return null;
  const request: Request & { limit?: number; offset?: number } = {};
  const filters: Record<string, string> = {};
  for (const [name, value] of ctx.query) {
    if (!RESERVED.includes(name)) {
      if (!NAME.test(name) || value.length === 0 || value.length > MAX_VALUE) return null;
      filters[name] = value;
    } else if (name === 'columns') {
      const columns = columnList(value.split(','));
      if (!columns) return null;
      request.columns = columns;
    } else if (name === 'sort') {
      if (!NAME.test(value)) return null;
      request.sort = value;
    } else if (name === 'direction') {
      if (value !== 'asc' && value !== 'desc') return null;
      request.direction = value;
    } else {
      if (!COUNT.test(value)) return null;
      request[name as 'limit' | 'offset'] = Number(value);
    }
  }
  if (Object.keys(filters).length > MAX_FILTERS) return null;
  return { ...request, ...(Object.keys(filters).length > 0 ? { filters } : {}) };
}

function exportInput(ctx: RouteContext): (BffExportInput & Request) | null {
  const raw = body(ctx, ['format', 'columns', 'filters', 'sort', 'direction'], ['format']);
  if (!raw || !isFormat(raw['format'])) return null;
  const input: BffExportInput & Request = { format: raw['format'] };
  if (raw['columns'] !== undefined) {
    const columns = columnList(raw['columns']);
    if (!columns) return null;
    input.columns = columns;
  }
  if (raw['filters'] !== undefined) {
    const filters = filterMap(raw['filters']);
    if (!filters) return null;
    input.filters = filters;
  }
  if (raw['sort'] !== undefined) {
    if (typeof raw['sort'] !== 'string' || !NAME.test(raw['sort'])) return null;
    input.sort = raw['sort'];
  }
  if (raw['direction'] !== undefined) {
    if (raw['direction'] !== 'asc' && raw['direction'] !== 'desc') return null;
    input.direction = raw['direction'];
  }
  return input;
}

function windowQuery(ctx: RouteContext): { limit?: number; offset?: number } | null {
  const keys = [...ctx.query.keys()];
  if (keys.some((key) => key !== 'limit' && key !== 'offset') || new Set(keys).size !== keys.length)
    return null;
  const limit = ctx.query.get('limit');
  const offset = ctx.query.get('offset');
  if ((limit !== null && !COUNT.test(limit)) || (offset !== null && !COUNT.test(offset)))
    return null;
  return {
    ...(limit === null ? {} : { limit: Number(limit) }),
    ...(offset === null ? {} : { offset: Number(offset) }),
  };
}

/** The key comes from the header only; a repeated or malformed header is a bad request. */
function keyOf(ctx: RouteContext): { ok: true; key: string | undefined } | { ok: false } {
  const key = singleHeader(ctx.headers, IDEMPOTENCY_KEY_HEADER);
  if (ctx.headers[IDEMPOTENCY_KEY_HEADER] !== undefined && !isIdempotencyKey(key))
    return { ok: false };
  return { ok: true, key };
}

/** What the screen needs of a job: never the session, the request digest, the key or filter values. */
function shape(ctx: RouteContext, job: ExportJob, replayed = false): BffExport {
  const definition = ctx.platform.reports.catalog.get(job.reportId);
  const label = (id: string): string => definition?.filters.find((f) => f.id === id)?.label ?? id;
  return {
    id: job.id,
    reportId: job.reportId,
    reportTitle: definition?.title ?? job.reportId,
    format: job.format,
    status: job.status,
    mode: job.mode,
    rowCount: job.rowCount,
    byteSize: job.byteSize,
    fileName: job.fileName,
    failure: job.failure,
    filterNames: Object.keys(job.filters).map(label),
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    expiresAt: job.expiresAt,
    replayed,
  };
}

const REPORT = { reportId: ID };
const EXPORT = { exportId: ID };

export const REPORT_ROUTES: readonly Route[] = [
  route('reports.catalog', async (ctx) => {
    const result = await ctx.platform.reports.reports.catalog(
      ctx.token as string,
      ctx.correlationId,
    );
    if (!result.ok) return failure(ctx, result.error);
    const families = Object.entries(REPORT_FAMILIES)
      .filter(([id]) => result.value.reports.some((report) => report.family === id))
      .map(([id, label]) => ({ id, label }));
    return success(ctx, 'reports.catalog', {
      families,
      reports: result.value.reports.map((report) => ({
        ...report,
        columns: report.columns.map((c) => ({
          id: c.id,
          label: c.label,
          kind: c.kind,
          defaultVisible: c.defaultVisible !== false,
        })),
      })),
      canExport: result.value.canExport,
    } as BffReportCatalog);
  }),
  route(
    'reports.preview',
    async (ctx) => {
      const query = previewQuery(ctx);
      if (!query) return bad(ctx);
      const result = await ctx.platform.reports.reports.preview(
        ctx.token as string,
        ctx.correlationId,
        ctx.params['reportId'] as string,
        query,
      );
      if (!result.ok) return failure(ctx, result.error);
      return success(ctx, 'reports.preview', {
        ...result.value,
        columns: result.value.columns.map((c) => ({
          id: c.id,
          label: c.label,
          kind: c.kind,
          defaultVisible: c.defaultVisible !== false,
        })),
      } as BffReportPreview);
    },
    REPORT,
  ),
  route(
    'reports.export',
    async (ctx) => {
      const input = exportInput(ctx);
      const key = keyOf(ctx);
      if (!input || !key.ok) return bad(ctx);
      const result = await ctx.platform.reports.exports.create(
        ctx.token as string,
        ctx.correlationId,
        {
          reportId: ctx.params['reportId'] as string,
          ...input,
          ...(key.key === undefined ? {} : { idempotencyKey: key.key }),
        },
      );
      if (!result.ok) return failure(ctx, result.error);
      return success(ctx, 'reports.export', shape(ctx, result.value.job, result.value.replayed));
    },
    REPORT,
  ),
  route('exports.list', async (ctx) => {
    const window = windowQuery(ctx);
    if (!window) return bad(ctx);
    const result = await ctx.platform.reports.exports.list(
      ctx.token as string,
      ctx.correlationId,
      window,
    );
    if (!result.ok) return failure(ctx, result.error);
    return success(ctx, 'exports.list', {
      items: result.value.items.map((job) => shape(ctx, job)),
      total: result.value.total,
      offset: window.offset ?? 0,
      limit: window.limit ?? 25,
    });
  }),
  route(
    'exports.get',
    async (ctx) => {
      const result = await ctx.platform.reports.exports.get(
        ctx.token as string,
        ctx.correlationId,
        ctx.params['exportId'] as string,
      );
      if (!result.ok) return failure(ctx, result.error);
      return success(ctx, 'exports.get', shape(ctx, result.value));
    },
    EXPORT,
  ),
  route(
    'exports.download',
    async (ctx): Promise<BffResponse> => {
      const result = await ctx.platform.reports.exports.download(
        ctx.token as string,
        ctx.correlationId,
        ctx.params['exportId'] as string,
      );
      if (!result.ok) return failure(ctx, result.error);
      return fileResponse(result.value, ctx.correlationId);
    },
    EXPORT,
  ),
];
