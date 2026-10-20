import { createFakeReports } from '../features/reports/fakePorts';
import type { ReportsPorts } from '../features/reports/ports';
import type { Guarded } from './mockApiTypes';

/** Reports of the demo API: reading needs `view`, exporting needs `export` as well. */
export function createMockReportsPorts(guarded: Guarded): ReportsPorts {
  const store = createFakeReports();
  return {
    catalog: () => guarded('reports', 'view', () => store.catalog()),
    preview: (reportId, query) => guarded('reports', 'view', () => store.preview(reportId, query)),
    exportReport: (reportId, input, key) =>
      guarded('exportReport', ['view', 'export'], () => store.exportReport(reportId, input, key)),
    exports: (query) => guarded('listExports', 'view', () => store.exports(query)),
    downloadHref: (exportId) => store.downloadHref(exportId),
  };
}
