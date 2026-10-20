import { describe, expect, it } from 'vitest';
import { renderExport } from './index.js';
import { table } from './test-support.js';

describe('renderExport', () => {
  it.each([
    ['csv', 'text/csv; charset=utf-8'],
    ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['pdf', 'application/pdf'],
  ] as const)('renders %s', async (format, contentType) => {
    const out = await renderExport(format, table([['a', 1, 2, null]]));
    expect(out.contentType).toBe(contentType);
    expect(out.extension).toBe(format);
    expect(out.bytes.byteLength).toBeGreaterThan(10);
  });
});
