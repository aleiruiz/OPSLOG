import { renderCsv } from './csv.js';
import { renderPdf } from './pdf.js';
import { renderXlsx } from './xlsx.js';
import type { ExportFormat, ExportTable, RenderedExport } from './types.js';

export * from './types.js';
export { neutralizeFormula, stripControl } from './formula.js';
export { renderCsv, csvField } from './csv.js';
export { renderXlsx } from './xlsx.js';
export { renderPdf, cutoffText } from './pdf.js';

/** Renders the table in the requested format. */
export async function renderExport(
  format: ExportFormat,
  table: ExportTable,
): Promise<RenderedExport> {
  if (format === 'csv') return renderCsv(table);
  if (format === 'xlsx') return renderXlsx(table);
  return renderPdf(table);
}
