import type { Permission } from '../../identity/src/index.js';
import type { ReportSources } from './ports.js';

/** Format a report can be exported in. */
export type ReportFormat = 'csv' | 'xlsx' | 'pdf';
export const REPORT_FORMATS: readonly ReportFormat[] = ['csv', 'xlsx', 'pdf'];

export type ReportFamily = 'workforce' | 'vehicles' | 'maintenance' | 'incidents' | 'transversal';

/** Families as the catalog groups them (BRD §13.1), in display order. */
export const REPORT_FAMILIES: Readonly<Record<ReportFamily, string>> = {
  workforce: 'Plantilla',
  vehicles: 'Vehículos',
  maintenance: 'Mantenimiento',
  incidents: 'Siniestros',
  transversal: 'Transversal',
};

/**
 * What a column protects. Without the matching permission the column is not queried and not
 * written: it is removed from the plan, never hidden afterwards.
 */
export type Sensitivity = 'pii' | 'costs' | 'incident_costs';

export const SENSITIVITY_PERMISSION: Readonly<Record<Sensitivity, Permission>> = {
  pii: 'view_pii',
  costs: 'view_costs',
  incident_costs: 'incidents:view_costs',
};

export type ColumnKind = 'text' | 'integer' | 'number' | 'date';
/** A cell: text, a number, a `YYYY-MM-DD` day (in a `date` column) or empty. */
export type Cell = string | number | null;
/** Keys that start with `_` are internal facts for filters; they are never projected. */
export type Row = Readonly<Record<string, Cell>>;

export interface ReportColumn {
  readonly id: string;
  /** Spanish header, shown in the screen and in every file. */
  readonly label: string;
  readonly kind: ColumnKind;
  readonly sensitivity?: Sensitivity;
  /** Selected when the request names no columns. Default true. */
  readonly defaultVisible?: boolean;
}

export type FilterKind = 'enum' | 'id' | 'text' | 'date' | 'number';
export type FilterValue = string | number;

export interface FilterOption {
  readonly value: string;
  readonly label: string;
}

export interface ReportFilter {
  readonly id: string;
  readonly label: string;
  readonly kind: FilterKind;
  /** The only values an `enum` filter accepts. */
  readonly options?: readonly FilterOption[];
  /** True when the row passes the filter; it reads the internal `_` facts of the row. */
  readonly test: (row: Row, value: FilterValue) => boolean;
}

export type SortDirection = 'asc' | 'desc';

export interface ReportContext {
  readonly tenantId: string;
  readonly permissions: ReadonlySet<Permission>;
  /** IANA zone of the company: days, "days left" and "days in state" are counted in it. */
  readonly timeZone: string;
  /** Today in the company's zone, `YYYY-MM-DD`. */
  readonly today: string;
  readonly now: Date;
}

export interface ReportDefinition {
  readonly id: string;
  readonly family: ReportFamily;
  readonly title: string;
  readonly description: string;
  /** Permission to see the report (the read permission of the module). Exporting also needs `export`. */
  readonly view: Permission;
  readonly columns: readonly ReportColumn[];
  readonly filters: readonly ReportFilter[];
  readonly formats: readonly ReportFormat[];
  readonly defaultSort: { readonly column: string; readonly direction: SortDirection };
  /**
   * The rows of the report with the fields of `needed` filled. A sensitive column that is not in
   * `needed` must not be read from its source.
   */
  readonly load: (
    ctx: ReportContext,
    needed: ReadonlySet<string>,
    sources: ReportSources,
  ) => Promise<readonly Row[]>;
}

/** What a caller asks of a report; every value is validated against the definition. */
export interface ReportRequest {
  readonly filters?: Readonly<Record<string, string>>;
  readonly columns?: readonly string[];
  readonly sort?: string;
  readonly direction?: SortDirection;
}

/** A validated request: only columns the reader may see, filters of the allowlist, a sort that exists. */
export interface ReportPlan {
  readonly definition: ReportDefinition;
  readonly columns: readonly ReportColumn[];
  readonly filters: ReadonlyMap<string, FilterValue>;
  readonly sort: { readonly column: string; readonly direction: SortDirection };
}

export interface ReportResult {
  readonly columns: readonly ReportColumn[];
  /** Rows projected to the selected columns, in order. */
  readonly rows: readonly Row[];
  readonly total: number;
}

export interface ReportSummary {
  readonly id: string;
  readonly family: ReportFamily;
  readonly title: string;
  readonly description: string;
  readonly columns: readonly ReportColumn[];
  readonly filters: readonly Pick<ReportFilter, 'id' | 'label' | 'kind' | 'options'>[];
  readonly formats: readonly ReportFormat[];
  readonly defaultSort: ReportDefinition['defaultSort'];
}
