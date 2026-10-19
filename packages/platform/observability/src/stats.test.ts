import { describe, expect, it } from 'vitest';
import { countsByStatus, OPS_STAT_KEYS } from './stats.js';

describe('countsByStatus', () => {
  it('sums the requested statuses, reading MySQL counts that arrive as strings', () => {
    const count = countsByStatus([
      { status: 'pending', total: 3 },
      { status: 'failed', total: '2' },
    ]);
    expect(count('pending')).toBe(3);
    expect(count('pending', 'failed')).toBe(5);
    expect(count('dead_letter')).toBe(0);
  });
});

describe('OPS_STAT_KEYS', () => {
  it('has unique camel-case counter names the logger accepts', () => {
    expect(new Set(OPS_STAT_KEYS).size).toBe(OPS_STAT_KEYS.length);
    for (const key of OPS_STAT_KEYS) expect(key).toMatch(/^[a-z][a-zA-Z0-9]{0,39}$/);
  });
});
