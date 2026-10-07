import { describe, expect, it } from 'vitest';
import { parseCsv } from './csv';
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
