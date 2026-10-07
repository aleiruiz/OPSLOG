import { describe, expect, it } from 'vitest';
import { demoImports } from './fixtures';
import { encodeCsvCell, errorReportCsv, parseCsv } from './csv';
import { newIdempotencyKey } from './idempotency';
import { IDEMPOTENCY_KEY } from './rules';

describe('parseCsv', () => {
  it('reads quoted cells, escaped quotes, CRLF, blank lines and a byte-order mark', () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\n\n1,2')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
      ['1', '2'],
    ]);
    expect(parseCsv('a,b\r1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('a,"b\nc"')).toEqual([['a', 'b\nc']]);
    expect(parseCsv('a,""')).toEqual([['a', '']]);
  });

  it('refuses what the server refuses', () => {
    expect(parseCsv('a,"b')).toBeNull();
    expect(parseCsv('a,b"c"')).toBeNull();
    expect(parseCsv('"a"b,c')).toBeNull();
    expect(parseCsv('"a""b"x')).toBeNull();
  });
});

describe('error report CSV', () => {
  it('keeps the seeded 300-row import report aligned with its 12-error summary', () => {
    const first = demoImports()[0];
    expect(first?.job.totalRows).toBe(300);
    expect(first?.rows).toHaveLength(300);
    expect(first?.rows.filter((row) => row.outcome === 'invalid')).toHaveLength(12);
    expect(first?.rows.filter((row) => row.outcome === 'imported')).toHaveLength(288);
  });

  it('contains only sanitized row metadata and quotes formula-leading text', () => {
    const report = errorReportCsv([
      {
        rowNumber: 4,
        outcome: 'invalid',
        code: 'invalid_value',
        columns: ['firstName', '=1+2'],
        entityId: null,
        at: '2026-10-06T12:00:00Z',
      },
      {
        rowNumber: 5,
        outcome: 'imported',
        code: null,
        columns: [],
        entityId: 'employee-private-id',
        at: '2026-10-06T12:00:00Z',
      },
    ]);
    expect(report).toContain('"Fila","Resultado","Código","Motivo","Columnas"');
    expect(report).toContain('"4","Con error","invalid_value"');
    expect(report).not.toContain('employee-private-id');
    expect(encodeCsvCell('=1+2')).toBe('"\'=1+2"');
  });
});

describe('newIdempotencyKey', () => {
  it('is a valid key, different each time, and never carries file data', () => {
    const a = newIdempotencyKey();
    expect(IDEMPOTENCY_KEY.test(a)).toBe(true);
    expect(a).not.toBe(newIdempotencyKey());
    expect(a.length).toBeLessThanOrEqual(64);
    expect(newIdempotencyKey(() => new Uint8Array([0, 1, 255]))).toBe('imp-0001ff');
    expect(IDEMPOTENCY_KEY.test(newIdempotencyKey(() => new Uint8Array([])))).toBe(true);
  });
});
