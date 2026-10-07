import { createHash } from 'node:crypto';
import type { ImportEntity, RowIssue, RowIssueCode } from './types.js';
import { IMPORT_COLUMNS, MAX_CELL_LENGTH, columnsOf } from './columns.js';
import type { RawRow, Submission } from './parsing.js';

const FORMULA_LEAD = /^[=@]/;
const SIGN_LEAD = /^[+-]/;
const PHONE_LIKE = /^\+[0-9][0-9 ().-]{5,24}$/;
const DIGITS = /^\d{1,7}$/;

/**
 * Spreadsheet formula injection: a cell that starts (after trimming, so tabs and carriage returns
 * count) with `=`, `@`, `+` or `-` would run as a formula when the data is opened in a spreadsheet.
 * The one legitimate exception is an international phone number in the `phone` column.
 */
export function isFormula(column: string, text: string): boolean {
  if (FORMULA_LEAD.test(text)) return true;
  return SIGN_LEAD.test(text) && !(column === 'phone' && PHONE_LIKE.test(text));
}

export interface PreparedRow {
  /** 1-based position in the request. */
  readonly rowNumber: number;
  /** The create request of the entity (typed values), or null when the row has an issue. */
  readonly input: Readonly<Record<string, unknown>> | null;
  readonly issue: RowIssue | null;
}

export const issue = (code: RowIssueCode, columns: readonly string[]): RowIssue => ({
  code,
  columns,
});

/**
 * Turns one raw row into the create request of its entity: cells are trimmed, empty cells are
 * absent, numeric columns are read as integers. An issue names the columns at fault, never a value.
 */
export function prepareRow(entity: ImportEntity, rowNumber: number, raw: RawRow): PreparedRow {
  const spec = IMPORT_COLUMNS[entity];
  const values: Record<string, unknown> = {};
  const formulas: string[] = [];
  const bad: string[] = [];
  for (const column of columnsOf(entity)) {
    const cell = Object.hasOwn(raw, column) ? raw[column] : undefined;
    if (cell === undefined || cell === null) continue;
    let text: string;
    if (typeof cell === 'number') {
      if (!Number.isSafeInteger(cell) || cell < 0) {
        bad.push(column);
        continue;
      }
      text = String(cell);
    } else if (typeof cell === 'string') text = cell.trim();
    else {
      bad.push(column);
      continue;
    }
    if (text === '') continue;
    if (text.length > MAX_CELL_LENGTH) bad.push(column);
    else if (isFormula(column, text)) formulas.push(column);
    else values[column] = text;
  }
  if (formulas.length > 0)
    return { rowNumber, input: null, issue: issue('formula_injection', formulas) };
  const missing = spec.required.filter(
    (column) => !Object.hasOwn(values, column) && !bad.includes(column),
  );
  if (missing.length > 0) return { rowNumber, input: null, issue: issue('missing_value', missing) };
  for (const column of spec.integers) {
    const text = values[column];
    if (typeof text !== 'string') continue;
    if (DIGITS.test(text)) values[column] = Number(text);
    else bad.push(column);
  }
  if (bad.length > 0)
    return { rowNumber, input: null, issue: issue('invalid_value', [...new Set(bad)]) };
  return { rowNumber, input: values, issue: null };
}

/** Stable SHA-256 of the rows: personal data columns count only as present or absent, never as values. */
export function fingerprintOf(submission: Pick<Submission, 'entity' | 'rows'>): string {
  const pii = IMPORT_COLUMNS[submission.entity].pii;
  const canonical = submission.rows.map((row) =>
    Object.keys(row)
      .sort()
      .map((column) => {
        const cell = row[column];
        const text = typeof cell === 'string' ? cell.trim() : cell === null ? '' : String(cell);
        return [column, pii.includes(column) ? text !== '' : text];
      }),
  );
  return createHash('sha256')
    .update(JSON.stringify([submission.entity, canonical]))
    .digest('hex');
}
