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
  it('keeps input borders at 3:1 against surface and page background (WCAG 1.4.11)', () => {
    const channel = (value: number) => {
      const unit = value / 255;
      return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((index) =>
        channel(parseInt(hex.slice(index, index + 2), 16)),
      );
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const ratio = (a: string, b: string) => {
      const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (light! + 0.05) / (dark! + 0.05);
    };
    const { inputBorder, surface, background } = opslogTokens.colors;
    expect(ratio(inputBorder, surface)).toBeGreaterThanOrEqual(3);
    expect(ratio(inputBorder, background)).toBeGreaterThanOrEqual(3);
    expect(opslogTheme.components?.MuiOutlinedInput?.styleOverrides).toBeDefined();
  });
});
