import { neutralizeFormula, stripControl } from './formula.js';
import { CONTENT_TYPES, type ExportCell, type ExportTable, type RenderedExport } from './types.js';

const BOM = '﻿';
const EOL = '\r\n';

/** RFC 4180: a field with a comma, a quote or a line break is quoted, and quotes are doubled. */
export function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function plainNumber(value: number): string {
  if (!Number.isFinite(value)) return '';
  return Math.abs(value) < 1e21 ? String(value) : BigInt(Math.trunc(value)).toString();
}

function cellText(cell: ExportCell): string {
  if (cell === null) return '';
  if (typeof cell === 'number') return plainNumber(cell);
  // Every string passes the guard, whatever the declared kind: a date or status column can be fed by free text.
  return neutralizeFormula(stripControl(cell));
}

/**
 * CSV of the table: UTF-8 with BOM, CRLF line ends, the Spanish labels as header. Text goes
 * through the formula guard; numbers and dates are written bare. Rows are consumed one at a time.
 */
export function renderCsv(table: ExportTable): RenderedExport {
  const chunks: Buffer[] = [Buffer.from(BOM, 'utf8')];
  chunks.push(
    Buffer.from(table.columns.map((c) => csvField(stripControl(c.label))).join(',') + EOL, 'utf8'),
  );
  let batch: string[] = [];
  for (const row of table.rows) {
    batch.push(row.map((cell) => csvField(cellText(cell))).join(','));
    if (batch.length >= 500) {
      chunks.push(Buffer.from(batch.join(EOL) + EOL, 'utf8'));
      batch = [];
    }
  }
  if (batch.length > 0) chunks.push(Buffer.from(batch.join(EOL) + EOL, 'utf8'));
  return {
    bytes: new Uint8Array(Buffer.concat(chunks)),
    contentType: CONTENT_TYPES.csv,
    extension: 'csv',
  };
}
