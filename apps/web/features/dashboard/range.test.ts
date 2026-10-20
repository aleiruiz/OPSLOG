import { describe, expect, it } from 'vitest';
import { customRangeError, rangeOf } from './range';

describe('dashboard ranges', () => {
  it('resolves the shortcuts on the company day', () => {
    expect(rangeOf('today', '2026-10-06')).toEqual({ from: '2026-10-06', to: '2026-10-06' });
    expect(rangeOf('7', '2026-10-06')).toEqual({ from: '2026-09-30', to: '2026-10-06' });
    expect(rangeOf('month', '2026-10-06')).toEqual({ from: '2026-10-01', to: '2026-10-06' });
    expect(rangeOf('quarter', '2026-11-20')).toEqual({ from: '2026-10-01', to: '2026-11-20' });
    expect(rangeOf('quarter', '2026-03-31')).toEqual({ from: '2026-01-01', to: '2026-03-31' });
    expect(rangeOf('default', '2026-10-06')).toBeNull();
  });

  it('rejects incomplete, inverted and too long custom ranges', () => {
    expect(customRangeError('', '2026-10-01')).toMatch(/fecha inicial y la final/);
    expect(customRangeError('2026-10-02', '2026-10-01')).toMatch(/posterior/);
    expect(customRangeError('2025-01-01', '2026-10-01')).toMatch(/366/);
    expect(customRangeError('2026-09-01', '2026-10-01')).toBeNull();
  });
});
