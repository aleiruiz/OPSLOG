/**
 * RFC 4180 reader, the same one the server uses: comma separated, double-quoted cells with `""` escapes, CRLF or LF,
 * an optional byte-order mark, blank lines skipped. Anything else (a quote inside an unquoted cell, text after a
 * closing quote, an unterminated quote) is malformed and gives `null`, which the server would answer with a 400.
 */
export function parseCsv(text: string): string[][] | null {
  const source = text.startsWith('﻿') ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let wasQuoted = false;
  const endCell = (): void => {
    row.push(cell);
    cell = '';
    wasQuoted = false;
  };
  const endRow = (): void => {
    endCell();
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
  };
  for (let i = 0; i < source.length; i += 1) {
    const char = source.charAt(i);
    if (quoted) {
      if (char !== '"') cell += char;
      else if (source.charAt(i + 1) === '"') {
        cell += '"';
        i += 1;
      } else {
        quoted = false;
        wasQuoted = true;
      }
    } else if (char === '"') {
      if (cell !== '' || wasQuoted) return null;
      quoted = true;
    } else if (wasQuoted && char !== ',' && char !== '\n' && char !== '\r') {
      return null;
    } else if (char === ',') endCell();
    else if (char === '\n') endRow();
    else if (char === '\r') {
      if (source.charAt(i + 1) === '\n') i += 1;
      endRow();
    } else cell += char;
  }
  if (quoted) return null;
  if (cell !== '' || wasQuoted || row.length > 0) endRow();
  return rows;
}
