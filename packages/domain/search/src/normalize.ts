import { MAX_TERM_LENGTH } from './types.js';

/**
 * The key form of a text (BRD §14.1): lower case, no accents, and no hyphens, spaces, dots or
 * underscores, so «ÁBC-123», «abc 123» and «abc.123» are the same key.
 */
export function normalizeKey(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[\s.\-_]/gu, '');
}

/**
 * The term a reader typed, ready to match: `null` when nothing searchable remains or it is longer
 * than any key. A term is never trusted as a pattern: wildcards are removed.
 */
export function searchTerm(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > MAX_TERM_LENGTH * 2) return null;
  const term = normalizeKey(raw).replace(/[%_\\"+\-<>()~*@]/gu, '');
  return term.length === 0 || term.length > MAX_TERM_LENGTH ? null : term;
}
