/** Kind of a column of an export table: it decides how a cell is typed in the file. */
export type ExportColumnKind = 'text' | 'integer' | 'number' | 'date';

/** A cell: text, a number, a calendar day (`YYYY-MM-DD`) or empty. Never a formula. */
export type ExportCell = string | number | null;

export interface ExportColumn {
  readonly label: string;
  readonly kind: ExportColumnKind;
}

/** What the header and footer of a document say (the PDF prints all of it; CSV and XLSX keep the properties). */
export interface ExportMeta {
  readonly companyName: string;
  readonly generatedAt: Date;
  /** IANA zone of the company: the cut-off date is printed in it. */
  readonly timeZone: string;
  readonly authorLabel: string;
  /** Names of the filters in use, never their values. */
  readonly filterNames: readonly string[];
}

export interface ExportTable {
  readonly title: string;
  readonly columns: readonly ExportColumn[];
  readonly rows: Iterable<readonly ExportCell[]>;
  readonly meta: ExportMeta;
}

export type ExportFormat = 'csv' | 'xlsx' | 'pdf';

export interface RenderedExport {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly extension: string;
}

export const CONTENT_TYPES: Readonly<Record<ExportFormat, string>> = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
};
