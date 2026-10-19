import { bffPath, type BffClient } from '@opslog/contracts';
import type {
  BffExport,
  BffExportInput,
  BffExportList,
  BffExportsQuery,
  BffReportCatalog,
  BffReportPreview,
  BffReportPreviewQuery,
} from '@opslog/contracts';
import type { Result } from '../../app/types';

/**
 * What the reports screens need from the BFF (FR-150..153). The sensitive columns a reader may not
 * see never arrive: the server removes them from the catalog, the preview and the file.
 */
export interface ReportsPorts {
  catalog(): Promise<Result<BffReportCatalog>>;
  preview(reportId: string, query?: BffReportPreviewQuery): Promise<Result<BffReportPreview>>;
  /** `idempotencyKey` makes a retried request return the same export instead of a second one. */
  exportReport(
    reportId: string,
    input: BffExportInput,
    idempotencyKey?: string,
  ): Promise<Result<BffExport>>;
  exports(query?: BffExportsQuery): Promise<Result<BffExportList>>;
  /** Address the browser opens (with its session cookie) to download a finished file. */
  downloadHref(exportId: string): string;
}

export function createReportsPorts(client: BffClient): ReportsPorts {
  return {
    catalog: () => client.call('reports.catalog'),
    preview: (reportId, query) =>
      client.call('reports.preview', { params: { reportId }, ...(query ? { query } : {}) }),
    exportReport: (reportId, body, idempotencyKey) =>
      client.call('reports.export', {
        params: { reportId },
        body,
        ...(idempotencyKey ? { idempotencyKey } : {}),
      }),
    exports: (query) => client.call('exports.list', query ? { query } : undefined),
    downloadHref: (exportId) => bffPath('exports.download', { exportId }),
  };
}
