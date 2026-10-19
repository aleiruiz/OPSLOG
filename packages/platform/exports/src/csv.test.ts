import { describe, expect, it } from 'vitest';
import { csvField, renderCsv } from './csv.js';
import { HOSTILE, table } from './test-support.js';

const text = (bytes: Uint8Array): string => Buffer.from(bytes).toString('utf8');

describe('renderCsv', () => {
  it('writes the BOM, the Spanish header and CRLF line ends', () => {
    const out = renderCsv(table([['Ñ', 3, 1.5, '2026-10-19']]));
    expect(Buffer.from(out.bytes).subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(text(out.bytes)).toBe('﻿Texto,Cantidad,Importe,Día\r\nÑ,3,1.5,2026-10-19\r\n');
    expect(out.contentType).toBe('text/csv; charset=utf-8');
    expect(out.extension).toBe('csv');
  });

  it('quotes commas, quotes and line breaks (RFC 4180)', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('di "x"')).toBe('"di ""x"""');
    expect(csvField('l1\nl2')).toBe('"l1\nl2"');
    expect(csvField('plain')).toBe('plain');
    const out = text(renderCsv(table([['a,"b"\nc', null, null, null]])).bytes);
    expect(out).toContain('"a,""b""\nc",,,\r\n');
  });

  it('prefixes every text that would be a formula, and only text', () => {
    const rows = HOSTILE.map((value) => [value, -5, -0.25, null] as const);
    const lines = text(renderCsv(table(rows)).bytes).split('\r\n');
    for (const [index, value] of HOSTILE.entries()) {
      const line = lines[index + 1] as string;
      expect(line.startsWith(`'${value}`) || line.startsWith(`"'${value}`)).toBe(true);
      expect(line.endsWith(',-5,-0.25,')).toBe(true);
    }
  });

  it('drops control characters and handles huge and non-finite numbers', () => {
    const out = text(renderCsv(table([['a\u0000b', 1e21, Number.NaN, '2026-01-01']])).bytes);
    expect(out).toContain('ab,1000000000000000000000,,2026-01-01');
  });

  it('flushes in batches and writes an empty table with only the header', () => {
    const many = Array.from({ length: 1201 }, (_, i) => [`fila ${i}`, i, null, null] as const);
    const lines = text(renderCsv(table(many)).bytes).split('\r\n');
    expect(lines).toHaveLength(1201 + 2);
    expect(text(renderCsv(table([])).bytes)).toBe('﻿Texto,Cantidad,Importe,Día\r\n');
  });

  it('writes text in a short row as empty cells', () => {
    expect(text(renderCsv(table([['solo']])).bytes)).toContain('solo\r\n');
  });
});
