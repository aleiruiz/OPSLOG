import type { BffRouteDefinition } from './shared.js';

/** Formats a report can be exported in (BRD §13.2). */
export const BFF_REPORT_FORMATS = ['csv', 'xlsx', 'pdf'] as const;
export type BffReportFormat = (typeof BFF_REPORT_FORMATS)[number];

export type BffReportFamilyId =
  | 'workforce'
  | 'vehicles'
  | 'maintenance'
  | 'incidents'
  | 'transversal';
export interface BffReportFamily {
  readonly id: BffReportFamilyId;
  readonly label: string;
}

export type BffReportColumnKind = 'text' | 'integer' | 'number' | 'date';
/** A column the reader may see: one they may not see is not listed at all. */
export interface BffReportColumn {
  readonly id: string;
  readonly label: string;
  readonly kind: BffReportColumnKind;
  /** Part of the report when the request names no columns. */
  readonly defaultVisible: boolean;
}

export type BffReportFilterKind = 'enum' | 'id' | 'text' | 'date' | 'number';
export interface BffReportFilterOption {
  readonly value: string;
  readonly label: string;
}
export interface BffReportFilter {
  readonly id: string;
  readonly label: string;
  readonly kind: BffReportFilterKind;
  readonly options?: readonly BffReportFilterOption[];
}

export interface BffReportSummary {
  readonly id: string;
  readonly family: BffReportFamilyId;
  readonly title: string;
  readonly description: string;
  readonly columns: readonly BffReportColumn[];
  readonly filters: readonly BffReportFilter[];
  readonly formats: readonly BffReportFormat[];
  readonly defaultSort: { readonly column: string; readonly direction: 'asc' | 'desc' };
}

export interface BffReportCatalog {
  readonly families: readonly BffReportFamily[];
  readonly reports: readonly BffReportSummary[];
  /** The reader holds `export`: the screen offers the export actions. */
  readonly canExport: boolean;
}

/** Cell of a preview row: text, a number, a `YYYY-MM-DD` day or empty. */
export type BffReportCell = string | number | null;

export interface BffReportPreview {
  readonly reportId: string;
  readonly columns: readonly BffReportColumn[];
  /** One array per row, in the order of `columns`. */
  readonly rows: readonly (readonly BffReportCell[])[];
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
}

/**
 * Query of a preview. Besides the reserved names, every key is a filter of the report; a key the
 * report does not define is a 400. `columns` is a comma-separated list of column ids.
 */
export interface BffReportPreviewQuery {
  readonly columns?: string;
  readonly sort?: string;
  readonly direction?: 'asc' | 'desc';
  readonly limit?: number;
  readonly offset?: number;
  readonly [filter: string]: string | number | undefined;
}

export const BFF_REPORT_RESERVED_QUERY = [
  'columns',
  'sort',
  'direction',
  'limit',
  'offset',
] as const;

export interface BffExportInput {
  readonly format: BffReportFormat;
  readonly columns?: readonly string[];
  readonly filters?: Readonly<Record<string, string>>;
  readonly sort?: string;
  readonly direction?: 'asc' | 'desc';
}

export type BffExportStatus = 'queued' | 'running' | 'completed' | 'failed' | 'expired';
export type BffExportFailure =
  | 'permission_revoked'
  | 'session_ended'
  | 'too_many_rows'
  | 'generation_failed';

export interface BffExport {
  readonly id: string;
  readonly reportId: string;
  readonly reportTitle: string;
  readonly format: BffReportFormat;
  readonly status: BffExportStatus;
  /** `direct`: the file was ready when the request answered; `job`: the worker produced it. */
  readonly mode: 'direct' | 'job';
  readonly rowCount: number | null;
  readonly byteSize: number | null;
  readonly fileName: string | null;
  readonly failure: BffExportFailure | null;
  /** Labels of the filters used, never their values. */
  readonly filterNames: readonly string[];
  readonly createdAt: string;
  readonly finishedAt: string | null;
  /** The file is available until this instant. */
  readonly expiresAt: string | null;
  /** True when the same `Idempotency-Key` returned the earlier export. */
  readonly replayed: boolean;
}

export interface BffExportList {
  readonly items: readonly BffExport[];
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
}

export interface BffExportsQuery {
  readonly limit?: number;
  readonly offset?: number;
}

export interface ReportRouteTypes {
  'reports.catalog': { response: BffReportCatalog };
  'reports.preview': {
    params: { reportId: string };
    query?: BffReportPreviewQuery;
    response: BffReportPreview;
  };
  'reports.export': {
    params: { reportId: string };
    body: BffExportInput;
    /** Optional `Idempotency-Key`: repeating it returns the same export. */
    idempotencyKey?: string;
    response: BffExport;
  };
  'exports.list': { query?: BffExportsQuery; response: BffExportList };
  'exports.get': { params: { exportId: string }; response: BffExport };
  /**
   * The file itself, proxied and authorized again by the API (403 when the permissions are gone,
   * 410 when it expired). The answer is the file, not JSON: the browser opens this path with its
   * session cookie and the JSON client never calls it.
   */
  'exports.download': { params: { exportId: string }; response: never };
}

export const REPORT_ROUTES = {
  'reports.catalog': {
    method: 'GET',
    path: ['api', 'v1', 'reports'],
    kind: 'session',
    status: 200,
  },
  'reports.preview': {
    method: 'GET',
    path: ['api', 'v1', 'reports', ':reportId', 'preview'],
    kind: 'session',
    status: 200,
  },
  'reports.export': {
    method: 'POST',
    path: ['api', 'v1', 'reports', ':reportId', 'exports'],
    kind: 'session-csrf',
    status: 201,
    idempotency: { requiredFor: [] },
  },
  'exports.list': { method: 'GET', path: ['api', 'v1', 'exports'], kind: 'session', status: 200 },
  'exports.get': {
    method: 'GET',
    path: ['api', 'v1', 'exports', ':exportId'],
    kind: 'session',
    status: 200,
  },
  'exports.download': {
    method: 'GET',
    path: ['api', 'v1', 'exports', ':exportId', 'download'],
    kind: 'session',
    status: 200,
  },
} as const satisfies Record<keyof ReportRouteTypes, BffRouteDefinition>;
