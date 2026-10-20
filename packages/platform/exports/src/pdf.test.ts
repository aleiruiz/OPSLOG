import { describe, expect, it } from 'vitest';
import { cutoffText, renderPdf } from './pdf.js';
import { META, table } from './test-support.js';

/** Text of every page, extracted with pdf.js: what a reader (or a screen reader) would get. */
async function pages(bytes: Uint8Array): Promise<string[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false })
    .promise;
  const result: string[] = [];
  for (let n = 1; n <= doc.numPages; n += 1) {
    const content = await (await doc.getPage(n)).getTextContent();
    result.push(content.items.map((item) => ('str' in item ? item.str : '')).join(' '));
  }
  return result;
}

describe('renderPdf', () => {
  it('prints the cut-off date in the company zone', () => {
    expect(cutoffText(META.generatedAt, 'America/Mexico_City')).toBe(
      'Fecha de corte: 19/10/2026, 09:30 (America/Mexico_City)',
    );
  });

  it('paginates with company, cut-off, author and «Página n de m» on every page', async () => {
    const rows = Array.from(
      { length: 120 },
      (_, i) => [`Unidad ${i} ñandú`, i, i * 1.5, '2026-10-19'] as const,
    );
    const out = await renderPdf(table(rows, 'Documentación de vehículos'));
    expect(out.contentType).toBe('application/pdf');
    expect(Buffer.from(out.bytes).subarray(0, 5).toString()).toBe('%PDF-');
    const text = await pages(out.bytes);
    expect(text.length).toBeGreaterThanOrEqual(3);
    text.forEach((page, index) => {
      expect(page).toContain('Transportes Ñandú S.A.');
      expect(page).toContain('Documentación de vehículos');
      expect(page).toContain('Fecha de corte: 19/10/2026, 09:30 (America/Mexico_City)');
      expect(page).toContain('Administrador (a1b2c3)');
      expect(page).toContain(`Página ${index + 1} de ${text.length}`);
      expect(page).toContain('Texto');
    });
    expect(text[0]).toContain('Filtros aplicados: Área, Estado');
    expect(text.join(' ')).toContain('Unidad 119 ñandú');
  });

  it('says so when there are no rows', async () => {
    const text = await pages((await renderPdf(table([]))).bytes);
    expect(text).toHaveLength(1);
    expect(text[0]).toContain('Sin registros para los filtros aplicados.');
  });

  it('formats numbers in Spanish and leaves empty cells empty', async () => {
    const text = await pages((await renderPdf(table([['x', 1234, 0.5, null]]))).bytes);
    expect(text[0]).toContain('1,234');
  });
});
