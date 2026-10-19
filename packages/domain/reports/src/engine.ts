import type { Permission } from '../../identity/src/index.js';
import { dayInZone, isDay } from './calendar.js';
import { ReportError } from './errors.js';
import type { ReportSources } from './ports.js';
import {
  SENSITIVITY_PERMISSION,
  type Cell,
  type FilterValue,
  type ReportColumn,
  type ReportContext,
  type ReportDefinition,
  type ReportFilter,
  type ReportPlan,
  type ReportRequest,
  type ReportResult,
  type ReportSummary,
  type Row,
} from './types.js';

const OPAQUE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_TEXT = 100;
const collator = new Intl.Collator('es', { sensitivity: 'base', numeric: true });

export class ReportCatalog {
  private readonly byId = new Map<string, ReportDefinition>();
  public constructor(public readonly definitions: readonly ReportDefinition[]) {
    for (const definition of definitions) {
      if (this.byId.has(definition.id)) throw new Error(`duplicate report: ${definition.id}`);
      const ids = new Set(definition.columns.map((c) => c.id));
      if (ids.size !== definition.columns.length)
        throw new Error(`duplicate column in ${definition.id}`);
      if (!ids.has(definition.defaultSort.column))
        throw new Error(`unknown default sort in ${definition.id}`);
      this.byId.set(definition.id, definition);
    }
  }
  public get(id: string): ReportDefinition | undefined {
    return this.byId.get(id);
  }
}

/** Columns the reader may see: a sensitive one needs the permission that protects it. */
export function permittedColumns(
  definition: ReportDefinition,
  permissions: ReadonlySet<Permission>,
): readonly ReportColumn[] {
  return definition.columns.filter(
    (column) => !column.sensitivity || permissions.has(SENSITIVITY_PERMISSION[column.sensitivity]),
  );
}

function parseFilter(filter: ReportFilter, raw: string): FilterValue {
  const bad = (): never => {
    throw new ReportError('invalid_input', filter.id);
  };
  if (raw.length === 0 || raw.length > MAX_TEXT) return bad();
  switch (filter.kind) {
    case 'enum':
      return filter.options?.some((option) => option.value === raw) ? raw : bad();
    case 'id':
      return OPAQUE_ID.test(raw) ? raw : bad();
    case 'date':
      return isDay(raw) ? raw : bad();
    case 'number': {
      const value = Number(raw);
      return Number.isFinite(value) ? value : bad();
    }
    default:
      return raw.trim().length > 0 ? raw.trim() : bad();
  }
}

/** Validates a request against a definition and the reader's permissions. */
export function planReport(
  definition: ReportDefinition,
  permissions: ReadonlySet<Permission>,
  request: ReportRequest = {},
): ReportPlan {
  if (!permissions.has(definition.view)) throw new ReportError('forbidden');
  const allowed = permittedColumns(definition, permissions);
  const allowedIds = new Set(allowed.map((c) => c.id));
  const known = new Set(definition.columns.map((c) => c.id));
  let columns: readonly ReportColumn[];
  if (request.columns === undefined) columns = allowed.filter((c) => c.defaultVisible !== false);
  else {
    const seen = new Set<string>();
    const picked: ReportColumn[] = [];
    for (const id of request.columns) {
      if (!known.has(id) || seen.has(id)) throw new ReportError('invalid_input', 'columns');
      seen.add(id);
      // A column the reader may not see is not an error: it is simply never part of the plan.
      if (allowedIds.has(id)) picked.push(allowed.find((c) => c.id === id) as ReportColumn);
    }
    columns = picked;
  }
  if (columns.length === 0) throw new ReportError('invalid_input', 'columns');
  const filters = new Map<string, FilterValue>();
  for (const [id, raw] of Object.entries(request.filters ?? {})) {
    const filter = definition.filters.find((candidate) => candidate.id === id);
    if (!filter || typeof raw !== 'string') throw new ReportError('invalid_input', 'filters');
    filters.set(id, parseFilter(filter, raw));
  }
  const sortColumn = request.sort ?? definition.defaultSort.column;
  if (!known.has(sortColumn)) throw new ReportError('invalid_input', 'sort');
  // Ordering by a column the reader may not see would reveal its order.
  if (!allowedIds.has(sortColumn)) throw new ReportError('forbidden', 'sort');
  if (
    request.direction !== undefined &&
    request.direction !== 'asc' &&
    request.direction !== 'desc'
  )
    throw new ReportError('invalid_input', 'direction');
  return {
    definition,
    columns,
    filters,
    sort: {
      column: sortColumn,
      direction: request.direction ?? (request.sort ? 'asc' : definition.defaultSort.direction),
    },
  };
}

function compare(a: Cell, b: Cell, direction: 'asc' | 'desc'): number {
  // Empty cells go last in both directions.
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  const order =
    typeof a === 'number' && typeof b === 'number' ? a - b : collator.compare(String(a), String(b));
  return direction === 'asc' ? order : -order;
}

export interface ReportEngineDeps {
  readonly sources: ReportSources;
  readonly timeZone: (tenantId: string) => Promise<string>;
  readonly now: () => Date;
}

/** Runs report definitions: plans a request, loads the rows, filters, orders and projects them. */
export class ReportEngine {
  public constructor(
    public readonly catalog: ReportCatalog,
    private readonly deps: ReportEngineDeps,
  ) {}

  /** The reports the reader may see, with only the columns they may see. */
  public summaries(permissions: ReadonlySet<Permission>): readonly ReportSummary[] {
    return this.catalog.definitions
      .filter((definition) => permissions.has(definition.view))
      .map((definition) => ({
        id: definition.id,
        family: definition.family,
        title: definition.title,
        description: definition.description,
        columns: permittedColumns(definition, permissions),
        filters: definition.filters.map(({ id, label, kind, options }) => ({
          id,
          label,
          kind,
          ...(options ? { options } : {}),
        })),
        formats: definition.formats,
        defaultSort: definition.defaultSort,
      }));
  }

  public plan(
    reportId: string,
    permissions: ReadonlySet<Permission>,
    request: ReportRequest = {},
  ): ReportPlan {
    const definition = this.catalog.get(reportId);
    if (!definition) throw new ReportError('not_found');
    return planReport(definition, permissions, request);
  }

  public async context(
    tenantId: string,
    permissions: ReadonlySet<Permission>,
  ): Promise<ReportContext> {
    const now = this.deps.now();
    const timeZone = await this.deps.timeZone(tenantId);
    return { tenantId, permissions, timeZone, today: dayInZone(now, timeZone), now };
  }

  /** Every row of the plan, filtered and ordered; `total` counts them all. */
  public async run(ctx: ReportContext, plan: ReportPlan): Promise<ReportResult> {
    const needed = new Set([...plan.columns.map((c) => c.id), plan.sort.column]);
    const loaded = await plan.definition.load(ctx, needed, this.deps.sources);
    const tests = [...plan.filters].map(([id, value]) => {
      const filter = plan.definition.filters.find(
        (candidate) => candidate.id === id,
      ) as ReportFilter;
      return (row: Row) => filter.test(row, value);
    });
    const kept = loaded.filter((row) => tests.every((test) => test(row)));
    const { column, direction } = plan.sort;
    const ordered = kept
      .map((row, index) => ({ row, index }))
      .sort(
        (x, y) =>
          compare(x.row[column] ?? null, y.row[column] ?? null, direction) || x.index - y.index,
      )
      .map(({ row }) => row);
    const rows = ordered.map((row) =>
      Object.fromEntries(plan.columns.map((c) => [c.id, row[c.id] ?? null] as const)),
    );
    return { columns: plan.columns, rows, total: rows.length };
  }
}
