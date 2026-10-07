import { parseCsv } from '../imports/csv';
import {
  MAX_CELL_LENGTH,
  MAX_CSV_LENGTH,
  MAX_HEADER_COLUMNS,
  columnsOf,
  templateOf,
} from '../imports/rules';
import { NAME } from '../employees/rules';
import { ECONOMIC_NUMBER, PLATE, normalizePlate } from '../vehicles/rules';
import type { ImportEntity, ImportRowCode } from './types';

export type RawRow = Readonly<Record<string, string | number | null>>;

export const INPUT_KEYS = ['entity', 'mode', 'idempotencyKey', 'dryRunJobId', 'rows', 'csv'];
const PHONE_LIKE = /^\+[0-9][0-9 ().-]{5,24}$/;
const DIGITS = /^\d{1,7}$/;

const isFormula = (column: string, text: string): boolean =>
  /^[=@]/.test(text) || (/^[+-]/.test(text) && !(column === 'phone' && PHONE_LIKE.test(text)));

export interface Issue {
  readonly code: ImportRowCode;
  readonly columns: readonly string[];
}

/** The columns of a request that hold personal data (what the caller needs `view_pii` for). */
export function importWritesPii(input: unknown): boolean {
  if (typeof input !== 'object' || input === null) return false;
  const fields = input as Readonly<Record<string, unknown>>;
  if (fields['entity'] !== 'employee') return false;
  const pii = templateOf('employee').pii;
  if (typeof fields['csv'] === 'string') {
    const header = parseCsv(fields['csv'])?.[0] ?? [];
    return header.some((name) => pii.includes(name.trim()));
  }
  const rows = fields['rows'];
  return (
    Array.isArray(rows) &&
    rows.some(
      (row) =>
        typeof row === 'object' &&
        row !== null &&
        Object.keys(row).some((key) => pii.includes(key)),
    )
  );
}

export function rowsOf(
  input: Readonly<Record<string, unknown>>,
  entity: ImportEntity,
): RawRow[] | null {
  const allowed = columnsOf(entity);
  if (typeof input['csv'] === 'string') {
    if (input['csv'].length > MAX_CSV_LENGTH) return null;
    const table = parseCsv(input['csv']);
    const [header, ...body] = table ?? [];
    if (!header || header.length > MAX_HEADER_COLUMNS) return null;
    const names = header.map((name) => name.trim());
    if (
      new Set(names).size !== names.length ||
      names.some((name) => !allowed.includes(name)) ||
      templateOf(entity).required.some((name) => !names.includes(name))
    )
      return null;
    if (body.some((cells) => cells.length !== names.length)) return null;
    return body.map((cells) => Object.fromEntries(names.map((name, i) => [name, cells[i] ?? ''])));
  }
  const rows = input['rows'];
  if (!Array.isArray(rows)) return null;
  const list: RawRow[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) return null;
    if (Object.keys(row).some((key) => !allowed.includes(key))) return null;
    list.push(row as RawRow);
  }
  return list;
}

/** The create request of a row, or the issue that makes it invalid (columns only). */
export function prepare(
  entity: ImportEntity,
  raw: RawRow,
): { input: Record<string, unknown> } | { issue: Issue } {
  const template = templateOf(entity);
  const values: Record<string, unknown> = {};
  const formulas: string[] = [];
  const bad: string[] = [];
  for (const column of columnsOf(entity)) {
    const cell = Object.hasOwn(raw, column) ? raw[column] : undefined;
    if (cell === undefined || cell === null) continue;
    const text = typeof cell === 'number' ? String(cell) : cell.trim();
    if (typeof cell === 'number' && (!Number.isSafeInteger(cell) || cell < 0)) {
      bad.push(column);
      continue;
    }
    if (text === '') continue;
    if (text.length > MAX_CELL_LENGTH) bad.push(column);
    else if (isFormula(column, text)) formulas.push(column);
    else values[column] = text;
  }
  if (formulas.length > 0) return { issue: { code: 'formula_injection', columns: formulas } };
  const missing = template.required.filter(
    (column) => !Object.hasOwn(values, column) && !bad.includes(column),
  );
  if (missing.length > 0) return { issue: { code: 'missing_value', columns: missing } };
  for (const column of entity === 'vehicle' ? ['year', 'odometerKm'] : []) {
    const text = values[column];
    if (typeof text !== 'string') continue;
    if (DIGITS.test(text)) values[column] = Number(text);
    else bad.push(column);
  }
  if (entity === 'vehicle') {
    if (
      typeof values['economicNumber'] === 'string' &&
      !ECONOMIC_NUMBER.test(values['economicNumber'])
    )
      bad.push('economicNumber');
    if (typeof values['plate'] === 'string' && !PLATE.test(normalizePlate(values['plate'])))
      bad.push('plate');
  } else {
    if (!['driver', 'dispatcher', 'other'].includes(String(values['kind']))) bad.push('kind');
    for (const column of ['firstName', 'lastName'])
      if (typeof values[column] === 'string' && !NAME.test(values[column])) bad.push(column);
  }
  if (bad.length > 0) return { issue: { code: 'invalid_value', columns: [...new Set(bad)] } };
  return { input: values };
}

/** Unique keys of a prepared row, as `column:value`. */
export function keysOf(entity: ImportEntity, input: Readonly<Record<string, unknown>>): string[] {
  const keys: string[] = [];
  const push = (column: string, value: unknown, normalize = (text: string) => text) => {
    if (typeof value === 'string') keys.push(`${column}:${normalize(value)}`);
  };
  if (entity === 'vehicle') {
    push('economicNumber', input['economicNumber'], (text) => text.toLowerCase());
    push('plate', input['plate'], (text) => normalizePlate(text));
    push('vin', input['vin'], (text) => text.toUpperCase());
  } else push('employeeNumber', input['employeeNumber'], (text) => text.toLowerCase());
  return keys;
}

/** Stable text of the rows: personal-data columns count only as present or absent, never as a value. */
export function fingerprintOf(entity: ImportEntity, rows: readonly RawRow[]): string {
  const pii = templateOf(entity).pii;
  return JSON.stringify([
    entity,
    rows.map((row) =>
      Object.keys(row)
        .sort()
        .map((column) => {
          const cell = row[column];
          const text = typeof cell === 'string' ? cell.trim() : cell === null ? '' : String(cell);
          return [column, pii.includes(column) ? text !== '' : text];
        }),
    ),
  ]);
}
