/** First characters that make a spreadsheet read a cell as a formula, after Unicode compatibility folding. */
const TRIGGERS = new Set(['=', '+', '-', '@', '\t', '\r']);

/**
 * Neutralizes a text cell against formula injection (OWASP CSV injection): text that starts with
 * `=`, `+`, `-`, `@`, a tab or a carriage return, or with their full-width variants (`＝`, `＋`,
 * `－`, `＠`), is prefixed with an apostrophe. The check runs on the NFKC form of the first
 * character, so a look-alike cannot slip through. Numbers and dates are typed cells and never pass here.
 */
export function neutralizeFormula(text: string): string {
  if (text.length === 0) return text;
  const first = String.fromCodePoint(text.codePointAt(0) as number).normalize('NFKC');
  return TRIGGERS.has(first.charAt(0)) ? `'${text}` : text;
}

/** Control characters other than tab, line feed and carriage return are never valid in XML or text files. */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
export const stripControl = (text: string): string => text.replace(CONTROL, '');
