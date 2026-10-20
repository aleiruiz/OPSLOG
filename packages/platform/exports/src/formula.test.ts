import { describe, expect, it } from 'vitest';
import { neutralizeFormula, stripControl } from './formula.js';
import { HOSTILE } from './test-support.js';

describe('neutralizeFormula', () => {
  it.each(HOSTILE)('prefixes %j', (text) => {
    expect(neutralizeFormula(text)).toBe(`'${text}`);
  });
  it('leaves ordinary text, empty text and an inner trigger alone', () => {
    expect(neutralizeFormula('Camión 3')).toBe('Camión 3');
    expect(neutralizeFormula('')).toBe('');
    expect(neutralizeFormula('a=b')).toBe('a=b');
    expect(neutralizeFormula('é=1')).toBe('é=1');
  });
  it('strips control characters but keeps tab and line breaks', () => {
    expect(stripControl('a\u0000b\u0007c\td\ne')).toBe('abc\td\ne');
  });
});
