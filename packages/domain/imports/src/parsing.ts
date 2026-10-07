import { requireOpaqueId } from '../../documents/src/index.js';
import { isImportEntity, isImportMode } from './types.js';
import type { ImportEntity, ImportMode } from './types.js';
import { invalid } from './errors.js';
import {
  IMPORT_COLUMNS,
  MAX_CSV_LENGTH,
  MAX_HEADER_COLUMNS,
  MAX_ROWS,
  columnsOf,
} from './columns.js';

type Fields = Readonly<Record<string, unknown>>;
export type RawRow = Readonly<Record<string, unknown>>;

function asFields(input: unknown, allowed: readonly string[]): Fields {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return invalid();
  const record = input as Fields;
  return Object.keys(record).some((key) => !allowed.includes(key)) ? invalid() : record;
}

export const guardId = (value: unknown): string => {
  try {
    return requireOpaqueId(value);
  } catch {
    return invalid();
  }
};

export const isInteger = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

/**
 * RFC 4180 reader: comma separated, double-quoted cells with `""` escapes, CRLF or LF, an optional
 * byte-order mark, blank lines skipped. Anything else (a quote inside an unquoted cell, text after
 * a closing quote, an unterminated quote) is `invalid_input`.
 */
export function parseCsv(text: string): string[][] {
  const source = text.startsWith('﻿') ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let wasQuoted = false;
  const endCell = (): void => {
    row.push(cell);
    cell = '';
    wasQuoted = false;
  };
  const endRow = (): void => {
    endCell();
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
  };
  for (let i = 0; i < source.length; i += 1) {
    const char = source.charAt(i);
    if (quoted) {
      if (char !== '"') cell += char;
      else if (source.charAt(i + 1) === '"') {
        cell += '"';
        i += 1;
      } else {
        quoted = false;
        wasQuoted = true;
      }
    } else if (char === '"') {
      if (cell !== '' || wasQuoted) return invalid();
      quoted = true;
    } else if (wasQuoted && char !== ',' && char !== '\n' && char !== '\r') {
      return invalid();
    } else if (char === ',') endCell();
    else if (char === '\n') endRow();
    else if (char === '\r') {
      if (source.charAt(i + 1) === '\n') i += 1;
      endRow();
    } else cell += char;
  }
  if (quoted) return invalid();
  if (cell !== '' || wasQuoted || row.length > 0) endRow();
  return rows;
}

export interface Submission {
  readonly entity: ImportEntity;
  readonly mode: ImportMode;
  readonly idempotencyKey: string | null;
  /** The dry run this commit confirms, when the caller wants the snapshot checked. */
  readonly dryRunJobId: string | null;
  /** Every column that appears in the request. */
  readonly columns: readonly string[];
  readonly rows: readonly RawRow[];
}

export const SUBMISSION_FIELDS = [
  'entity',
  'mode',
  'idempotencyKey',
  'dryRunJobId',
  'rows',
  'csv',
] as const;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,63}$/;

function rowsOfCsv(text: string, entity: ImportEntity): readonly RawRow[] {
  const table = parseCsv(text);
  const [header, ...body] = table;
  if (header === undefined || header.length > MAX_HEADER_COLUMNS) return invalid();
  const names = header.map((name) => name.trim());
  const allowed = columnsOf(entity);
  if (
    new Set(names).size !== names.length ||
    names.some((name) => !allowed.includes(name)) ||
    IMPORT_COLUMNS[entity].required.some((name) => !names.includes(name))
  )
    return invalid();
  return body.map((cells) => {
    if (cells.length !== names.length) return invalid();
    return Object.fromEntries(names.map((name, index) => [name, cells[index]])) as RawRow;
  });
}

function rowsOfObjects(value: unknown, entity: ImportEntity): readonly RawRow[] {
  if (!Array.isArray(value)) return invalid();
  const allowed = columnsOf(entity);
  return value.map((row: unknown): RawRow => {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) return invalid();
    if (Object.keys(row).some((key) => !allowed.includes(key))) return invalid();
    return row as RawRow;
  });
}

/** Validates the shape of an import request (rows are judged one by one later). Unknown properties are rejected. */
export function parseSubmission(input: unknown): Submission {
  const fields = asFields(input, SUBMISSION_FIELDS);
  const entity = fields['entity'];
  const mode = fields['mode'];
  if (!isImportEntity(entity) || !isImportMode(mode)) return invalid();
  const hasRows = Object.hasOwn(fields, 'rows');
  const hasCsv = Object.hasOwn(fields, 'csv');
  if (hasRows === hasCsv) return invalid();
  const key = fields['idempotencyKey'];
  if (key !== undefined && (typeof key !== 'string' || !IDEMPOTENCY_KEY.test(key)))
    return invalid();
  if (mode !== 'dry_run' && key === undefined) return invalid();
  const preview = fields['dryRunJobId'];
  if (preview !== undefined && mode === 'dry_run') return invalid();
  const csv = fields['csv'];
  if (hasCsv && (typeof csv !== 'string' || csv.length > MAX_CSV_LENGTH)) return invalid();
  const rows = hasCsv ? rowsOfCsv(csv as string, entity) : rowsOfObjects(fields['rows'], entity);
  if (rows.length < 1 || rows.length > MAX_ROWS) return invalid();
  return {
    entity,
    mode,
    idempotencyKey: key === undefined ? null : key,
    dryRunJobId: preview === undefined ? null : guardId(preview),
    columns: [...new Set(rows.flatMap((row) => Object.keys(row)))],
    rows,
  };
}

/** True when the request, taken as an employee import, carries personal data columns (needs the PII permission). */
export function importWritesPii(input: unknown): boolean {
  try {
    const submission = parseSubmission(input);
    return submission.columns.some((column) =>
      IMPORT_COLUMNS[submission.entity].pii.includes(column),
    );
  } catch {
    return false;
  }
}
