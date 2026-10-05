import { describe, expect, it } from 'vitest';
import { opslogTheme } from './theme';
import { opslogTokens } from './tokens';

describe('design tokens', () => {
  it('follows the SPECS §8 type and spacing scales', () => {
    expect(opslogTokens.typography.sizes).toEqual({ body: 14, h1: 22, h2: 16 });
    expect(opslogTokens.spacingScale).toEqual([4, 8, 12, 16, 24, 32, 48]);
    expect(opslogTokens.typography.fontFamily).toContain('IBM Plex Sans');
    expect(opslogTokens.typography.monoFamily).toContain('IBM Plex Mono');
  });
  it('feeds the Material UI theme', () => {
    expect(opslogTheme.typography.h1.fontSize).toBe('22px');
    expect(opslogTheme.typography.h2.fontSize).toBe('16px');
    expect(opslogTheme.spacing(1)).toBe('8px');
  });
});
