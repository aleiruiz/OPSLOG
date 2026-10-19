import type {
  ApiError,
  BffExport,
  BffExportInput,
  BffReportCatalog,
  BffReportCell,
  BffReportColumn,
  BffReportPreviewQuery,
  BffReportSummary,
} from '@opslog/contracts';
import type { Result } from '../../app/types';
import type { ReportsPorts } from './ports';

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = <T>(status: ApiError['status'], code = 'failure'): Result<T> => ({
  ok: false,
  error: { status, code, message: 'Failure', correlationId: 'corr-fake' },
});

const column = (
  id: string,
  label: string,
  kind: BffReportColumn['kind'] = 'text',
  defaultVisible = true,
): BffReportColumn => ({ id, label, kind, defaultVisible });

export const DEMO_REPORTS: readonly BffReportSummary[] = [
  {
    id: 'drivers',
    family: 'workforce',
    title: 'Conductores',
    description: 'Conductores con su licencia y su estatus.',
    columns: [
      column('name', 'Nombre'),
      column('area', 'Área'),
      column('status', 'Estatus'),
      column('licenseExpiresOn', 'Vigencia de licencia', 'date'),
    ],
    filters: [
      {
        id: 'status',
        label: 'Estatus',
        kind: 'enum',
        options: [
          { value: 'active', label: 'Activo' },
          { value: 'inactive', label: 'Inactivo' },
        ],
      },
    ],
    formats: ['csv', 'xlsx'],
    defaultSort: { column: 'name', direction: 'asc' },
  },
  {
    id: 'vehicle_inventory',
    family: 'vehicles',
    title: 'Inventario de vehículos',
    description: 'Vehículos con su área, estatus y odómetro.',
    columns: [
      column('economicNumber', 'Nº económico'),
      column('plate', 'Placa'),
      column('status', 'Estatus'),
      column('odometerKm', 'Odómetro (km)', 'integer'),
    ],
    filters: [{ id: 'plate', label: 'Placa', kind: 'text' }],
    formats: ['csv', 'xlsx'],
    defaultSort: { column: 'economicNumber', direction: 'asc' },
  },
  {
    id: 'vehicle_documents',
    family: 'vehicles',
    title: 'Documentos de vehículos',
    description: 'Vigencia de los documentos de cada vehículo.',
    columns: [column('vehicle', 'Vehículo'), column('expiresOn', 'Vencimiento', 'date')],
    filters: [],
    formats: ['csv', 'xlsx', 'pdf'],
    defaultSort: { column: 'expiresOn', direction: 'asc' },
  },
];

export const DEMO_FAMILIES: BffReportCatalog['families'] = [
  { id: 'workforce', label: 'Plantilla' },
  { id: 'vehicles', label: 'Vehículos' },
];

/** Rows of every demo report: a driver per number, a vehicle per number. */
function rowsOf(reportId: string, count: number): BffReportCell[][] {
  return Array.from({ length: count }, (_, i) => {
    const n = String(i + 1).padStart(3, '0');
    if (reportId === 'drivers')
      return [`Conductor ${n}`, 'Flota', i % 4 === 0 ? 'Inactivo' : 'Activo', '2027-01-31'];
    if (reportId === 'vehicle_inventory')
      return [`ECO-${n}`, `PLA-${n}`, i % 5 === 0 ? 'En taller' : 'Activo', i * 100];
    return [`ECO-${n}`, '2026-12-31'];
  });
}

export interface FakeReports extends ReportsPorts {
  /** Calls received, in order, for assertions. */
  readonly calls: { readonly name: string; readonly args: readonly unknown[] }[];
  readonly items: BffExport[];
  canExport: boolean;
  rowCount: number;
  /** Rows over which an export becomes a background job (the server uses 5.000). */
  directLimit: number;
  failNext(operation: 'catalog' | 'preview' | 'exportReport' | 'exports', status: number): void;
  /** The worker finished every open job. */
  finishJobs(): void;
}

/** An in-memory reports port that pages, filters and exports like the BFF does. */
export function createFakeReports(
  options: { rowCount?: number; canExport?: boolean; directLimit?: number } = {},
): FakeReports {
  const calls: FakeReports['calls'] = [] as never;
  const failures = new Map<string, number>();
  const items: BffExport[] = [];
  const keys = new Map<string, string>();
  const failed = <T>(operation: string): Result<T> | null => {
    const status = failures.get(operation);
    if (status === undefined) return null;
    failures.delete(operation);
    return fail<T>(status as ApiError['status']);
  };
  const record = (name: string, ...args: unknown[]) => void calls.push({ name, args });
  const fake: FakeReports = {
    calls,
    items,
    canExport: options.canExport ?? true,
    rowCount: options.rowCount ?? 60,
    directLimit: options.directLimit ?? 5_000,
    failNext: (operation, status) => void failures.set(operation, status),
    finishJobs: () => {
      for (const [index, item] of items.entries())
        if (item.status === 'queued' || item.status === 'running')
          items[index] = {
            ...item,
            status: 'completed',
            rowCount: fake.rowCount,
            byteSize: 2048,
            fileName: `${item.reportId}-20261019.${item.format}`,
            finishedAt: '2026-10-19T16:05:00.000Z',
            expiresAt: '2026-10-26T16:05:00.000Z',
          };
    },
    catalog: async () => {
      record('catalog');
      return (
        failed<BffReportCatalog>('catalog') ??
        ok({ families: DEMO_FAMILIES, reports: DEMO_REPORTS, canExport: fake.canExport })
      );
    },
    preview: async (reportId, query: BffReportPreviewQuery = {}) => {
      record('preview', reportId, query);
      const error = failed<never>('preview');
      if (error) return error;
      const report = DEMO_REPORTS.find((r) => r.id === reportId);
      if (!report) return fail(404, 'not_found');
      const wanted = query.columns ? query.columns.split(',') : null;
      const columns = report.columns.filter((c) => (wanted ? wanted.includes(c.id) : true));
      const all = rowsOf(reportId, fake.rowCount).filter((row) =>
        Object.entries(query).every(([name, value]) => {
          const index = report.columns.findIndex((c) => c.id === name);
          return index < 0 || String(row[index]) === String(value) || name === 'columns';
        }),
      );
      const limit = query.limit ?? 25;
      const offset = query.offset ?? 0;
      const indexes = columns.map((c) => report.columns.findIndex((x) => x.id === c.id));
      return ok({
        reportId,
        columns,
        rows: all.slice(offset, offset + limit).map((row) => indexes.map((i) => row[i] ?? null)),
        total: all.length,
        offset,
        limit,
      });
    },
    exportReport: async (reportId, input: BffExportInput, idempotencyKey) => {
      record('exportReport', reportId, input, idempotencyKey);
      const error = failed<never>('exportReport');
      if (error) return error;
      const report = DEMO_REPORTS.find((r) => r.id === reportId);
      if (!report) return fail(404, 'not_found');
      if (!fake.canExport) return fail(403, 'forbidden');
      const known = idempotencyKey ? keys.get(idempotencyKey) : undefined;
      const earlier = items.find((item) => item.id === known);
      if (earlier) return ok({ ...earlier, replayed: true });
      const direct = fake.rowCount <= fake.directLimit;
      const id = `exp-${items.length + 1}`;
      const item: BffExport = {
        id,
        reportId,
        reportTitle: report.title,
        format: input.format,
        status: direct ? 'completed' : 'queued',
        mode: direct ? 'direct' : 'job',
        rowCount: direct ? fake.rowCount : null,
        byteSize: direct ? 2048 : null,
        fileName: direct ? `${reportId}-20261019.${input.format}` : null,
        failure: null,
        filterNames: Object.keys(input.filters ?? {}),
        createdAt: '2026-10-19T16:00:00.000Z',
        finishedAt: direct ? '2026-10-19T16:00:01.000Z' : null,
        expiresAt: direct ? '2026-10-26T16:00:01.000Z' : null,
        replayed: false,
      };
      items.unshift(item);
      if (idempotencyKey) keys.set(idempotencyKey, id);
      return ok(item);
    },
    exports: async (query = {}) => {
      record('exports', query);
      const error = failed<never>('exports');
      if (error) return error;
      const limit = query.limit ?? 25;
      const offset = query.offset ?? 0;
      return ok({ items: items.slice(offset, offset + limit), total: items.length, offset, limit });
    },
    downloadHref: (exportId) => `/api/v1/exports/${exportId}/download`,
  };
  return fake;
}
