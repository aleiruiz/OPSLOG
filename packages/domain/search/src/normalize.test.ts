import { describe, expect, it } from 'vitest';
import { normalizeKey, searchTerm } from './normalize.js';

describe('normalizeKey', () => {
  it('lowers case and drops accents, hyphens, spaces, dots and underscores', () => {
    expect(normalizeKey('ÁBC-123')).toBe('abc123');
    expect(normalizeKey(' Pérez  Gómez. ')).toBe('perezgomez');
    expect(normalizeKey('a_b-c d.e')).toBe('abcde');
  });
});

describe('searchTerm', () => {
  it('normalizes what was typed', () => {
    expect(searchTerm('ÁBC 1')).toBe('abc1');
  });
  it('removes pattern characters so a term is never a pattern', () => {
    expect(searchTerm('a%b"c*')).toBe('abc');
    expect(searchTerm('%')).toBeNull();
  });
  it('refuses what is not text, is empty or is too long', () => {
    expect(searchTerm(7)).toBeNull();
    expect(searchTerm('  - ')).toBeNull();
    expect(searchTerm('a'.repeat(65))).toBeNull();
    expect(searchTerm('a'.repeat(200))).toBeNull();
  });
});
