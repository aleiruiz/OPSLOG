import { PassThrough } from 'node:stream';
import ExcelJS from 'exceljs';
import { neutralizeFormula, stripControl } from './formula.js';
import {
  CONTENT_TYPES,
  type ExportCell,
  type ExportColumn,
  type ExportTable,
  type RenderedExport,
} from './types.js';

const SHEET_NAME = 'Reporte';
const DATE_FORMAT = 'yyyy-mm-dd';
const FLUSH_EVERY = 500;

/** `YYYY-MM-DD` as the UTC midnight of that day, so the serial number is the calendar day itself. */
function dayOf(text: string): Date | string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return neutralizeFormula(stripControl(text));
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

/**
 * Every cell is typed: text is a string (guarded against formulas), numbers are numbers and days
 * are dates with a day format. A cell is never given as a formula object.
 */
function typed(cell: ExportCell, column: ExportColumn): ExcelJS.CellValue {
  if (cell === null) return null;
  if (typeof cell === 'number') return Number.isFinite(cell) ? cell : null;
  if (column.kind === 'date') return dayOf(cell);
  return neutralizeFormula(stripControl(cell));
}

/** Rough width in characters for a column, from its label and the first rows. */
function widths(table: ExportTable, sample: readonly (readonly ExportCell[])[]): number[] {
  return table.columns.map((column, index) => {
    let longest = column.label.length;
    for (const row of sample) longest = Math.max(longest, String(row[index] ?? '').length);
    return Math.min(60, Math.max(10, longest + 2));
  });
}

/**
 * XLSX of the table with the ExcelJS streaming writer: rows are committed as they come, so memory
 * does not grow with the row count beyond the compressed output. The workbook carries the company
 * as title and the cut-off as its creation date.
 */
export async function renderXlsx(table: ExportTable): Promise<RenderedExport> {
  const sink = new PassThrough();
  const chunks: Buffer[] = [];
  sink.on('data', (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<void>((resolve, reject) => {
    sink.on('end', resolve);
    sink.on('error', reject);
  });
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream: sink,
    useStyles: true,
    useSharedStrings: false,
  });
  workbook.creator = stripControl(table.meta.authorLabel);
  workbook.title = stripControl(`${table.title} - ${table.meta.companyName}`);
  workbook.created = table.meta.generatedAt;
  workbook.modified = table.meta.generatedAt;
  const sheet = workbook.addWorksheet(SHEET_NAME, {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  const iterator = table.rows[Symbol.iterator]();
  const sample: (readonly ExportCell[])[] = [];
  while (sample.length < 50) {
    const next = iterator.next();
    if (next.done) break;
    sample.push(next.value);
  }
  sheet.columns = table.columns.map((column, index) => ({
    header: stripControl(column.label),
    key: `c${index}`,
    width: widths(table, sample)[index] as number,
    ...(column.kind === 'date' ? { style: { numFmt: DATE_FORMAT } } : {}),
  }));
  const header = sheet.getRow(1);
  header.font = { bold: true };
  header.commit();
  let written = 0;
  const write = (row: readonly ExportCell[]): void => {
    sheet.addRow(row.map((cell, i) => typed(cell, table.columns[i] as ExportColumn))).commit();
    written += 1;
  };
  for (const row of sample) write(row);
  for (let next = iterator.next(); !next.done; next = iterator.next()) {
    write(next.value);
    if (written % FLUSH_EVERY === 0) await new Promise<void>((resolve) => setImmediate(resolve));
  }
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: table.columns.length } };
  sheet.commit();
  await workbook.commit();
  await finished;
  return {
    bytes: new Uint8Array(Buffer.concat(chunks)),
    contentType: CONTENT_TYPES.xlsx,
    extension: 'xlsx',
  };
}
