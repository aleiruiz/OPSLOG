import type { PiiCipher } from '../../../../packages/platform/pii/src/index.js';
import { csvField } from '../../../../packages/platform/exports/src/csv.js';
import {
  neutralizeFormula,
  stripControl,
} from '../../../../packages/platform/exports/src/formula.js';
import type { ExportedTable } from './catalog.js';
import { ExportError, type Cell, type Row, type TableMeta } from './types.js';

/** The output columns of a table: omitted ones are gone and each sealed column shows under its clear name. */
export function outputColumns(table: TableMeta, spec: ExportedTable): string[] {
  const sealed = new Map((spec.sealed ?? []).map((s) => [s.column, s.as]));
  const omitted = new Set(spec.omit ?? []);
  return table.columns.filter((c) => !omitted.has(c)).map((c) => sealed.get(c) ?? c);
}

/**
 * Turns database rows into archive rows: blind indexes and secrets dropped, sealed personal data
 * opened with the company cipher. A value that cannot be opened stops the export: an archive with a
 * silent hole would pass for a complete one.
 */
export async function* shapeRows(
  table: TableMeta,
  spec: ExportedTable,
  rows: AsyncIterable<Row>,
  cipher: PiiCipher,
  tenantId: string,
): AsyncGenerator<Row> {
  const sealed = new Map((spec.sealed ?? []).map((s) => [s.column, s]));
  const omitted = new Set(spec.omit ?? []);
  for await (const row of rows) {
    const out: Row = {};
    for (const column of table.columns) {
      if (omitted.has(column)) continue;
      const seal = sealed.get(column);
      const value = row[column] ?? null;
      if (!seal) {
        out[column] = value;
        continue;
      }
      if (value === null) {
        out[seal.as] = null;
        continue;
      }
      const entityId = seal.entityId.map((part) => String(row[part] ?? '')).join(':');
      try {
        out[seal.as] = await cipher.open(
          { tenantId, entityType: seal.entityType, entityId, field: seal.field },
          String(value),
        );
      } catch {
        throw new ExportError('pii_open_failed');
      }
    }
    yield out;
  }
}

/** JSON array, one row per line, so a large table never sits in memory as one string. */
export async function* jsonChunks(rows: AsyncIterable<Row>): AsyncGenerator<string> {
  let first = true;
  yield '[';
  for await (const row of rows) {
    yield `${first ? '\n' : ',\n'}  ${JSON.stringify(row)}`;
    first = false;
  }
  yield first ? ']\n' : '\n]\n';
}

function cellText(cell: Cell | undefined): string {
  if (cell === null || cell === undefined) return '';
  if (typeof cell === 'number') return Number.isFinite(cell) ? String(cell) : '';
  if (typeof cell === 'boolean') return cell ? 'true' : 'false';
  // Text passes the formula guard (OWASP CSV injection): the CSV is meant for spreadsheets, the JSON keeps the exact text.
  const text = typeof cell === 'string' ? cell : JSON.stringify(cell);
  return neutralizeFormula(stripControl(text));
}

/** RFC 4180 CSV with BOM and CRLF, the database column names as header. */
export async function* csvChunks(
  columns: readonly string[],
  rows: AsyncIterable<Row>,
): AsyncGenerator<string> {
  yield `﻿${columns.map(csvField).join(',')}\r\n`;
  let batch: string[] = [];
  for await (const row of rows) {
    batch.push(columns.map((c) => csvField(cellText(row[c]))).join(','));
    if (batch.length >= 500) {
      yield `${batch.join('\r\n')}\r\n`;
      batch = [];
    }
  }
  if (batch.length > 0) yield `${batch.join('\r\n')}\r\n`;
}

/** Counts the rows that flow through, for the manifest. */
export function counted<T>(rows: AsyncIterable<T>): {
  rows: AsyncIterable<T>;
  count: () => number;
} {
  let n = 0;
  return {
    rows: (async function* () {
      for await (const row of rows) {
        n += 1;
        yield row;
      }
    })(),
    count: () => n,
  };
}
