import { createRequire } from 'node:module';
import PDFDocument from 'pdfkit';
import { stripControl } from './formula.js';
import { CONTENT_TYPES, type ExportCell, type ExportTable, type RenderedExport } from './types.js';

const require = createRequire(import.meta.url);
const FONT = (weight: 400 | 600): string =>
  require.resolve(`@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-${weight}-normal.woff`);

const MARGIN = 36;
const FOOTER_Y = 24;
const BODY = 8;
const HEAD = 8;
const PAD = 3;

/** Cut-off line: date and time in the company's zone, with the zone name. */
export function cutoffText(at: Date, timeZone: string): string {
  const formatted = new Intl.DateTimeFormat('es-MX', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(at);
  return `Fecha de corte: ${formatted} (${timeZone})`;
}

function cellText(cell: ExportCell): string {
  if (cell === null) return '';
  return typeof cell === 'number'
    ? new Intl.NumberFormat('es-MX', { maximumFractionDigits: 6 }).format(cell)
    : stripControl(cell);
}

/** Column widths: proportional to the longest text of the label and the first rows, within the page. */
function columnWidths(
  table: ExportTable,
  rows: readonly (readonly ExportCell[])[],
  total: number,
): number[] {
  const weights = table.columns.map((column, index) => {
    let longest = column.label.length;
    for (const row of rows.slice(0, 200))
      longest = Math.max(longest, Math.min(40, cellText(row[index] ?? null).length));
    return Math.max(6, longest);
  });
  const sum = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => (w / sum) * total);
}

/**
 * Readable paginated PDF of the table (landscape A4, IBM Plex Sans embedded): every page repeats
 * the company, the title, the cut-off date in the company's zone, the author and the column
 * headers, and carries «Página n de m». Text is real text, so it can be selected and extracted.
 */
export async function renderPdf(table: ExportTable): Promise<RenderedExport> {
  const doc = new PDFDocument({
    size: 'A4',
    layout: 'landscape',
    margins: { top: MARGIN, bottom: MARGIN + 12, left: MARGIN, right: MARGIN },
    bufferPages: true,
    info: {
      Title: stripControl(`${table.title} - ${table.meta.companyName}`),
      Author: stripControl(table.meta.authorLabel),
      Creator: 'OPSLOG',
      CreationDate: table.meta.generatedAt,
    },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolve, reject) => {
    doc.on('end', resolve);
    doc.on('error', reject);
  });
  doc.registerFont('regular', FONT(400));
  doc.registerFont('bold', FONT(600));

  const rows = [...table.rows];
  const width = doc.page.width - MARGIN * 2;
  const widths = columnWidths(table, rows, width);
  const bottom = (): number => doc.page.height - doc.page.margins.bottom;

  const header = (): void => {
    doc
      .font('bold')
      .fontSize(13)
      .fillColor('#111111')
      .text(stripControl(table.meta.companyName), MARGIN, MARGIN);
    doc.font('bold').fontSize(11).text(stripControl(table.title));
    doc
      .font('regular')
      .fontSize(8)
      .fillColor('#444444')
      .text(
        `${cutoffText(table.meta.generatedAt, table.meta.timeZone)}   |   Generado por: ${stripControl(table.meta.authorLabel)}`,
      );
    if (table.meta.filterNames.length > 0)
      doc.text(`Filtros aplicados: ${table.meta.filterNames.map(stripControl).join(', ')}`);
    doc.moveDown(0.5);
    const y = doc.y;
    let x = MARGIN;
    doc.font('bold').fontSize(HEAD).fillColor('#111111');
    const height =
      Math.max(
        ...table.columns.map((c, i) =>
          doc.heightOfString(c.label, { width: (widths[i] as number) - PAD * 2 }),
        ),
      ) +
      PAD * 2;
    doc.rect(MARGIN, y, width, height).fill('#e8ecef');
    doc.fillColor('#111111');
    table.columns.forEach((column, i) => {
      doc.text(column.label, x + PAD, y + PAD, { width: (widths[i] as number) - PAD * 2 });
      x += widths[i] as number;
    });
    doc.y = y + height;
  };

  header();
  for (const row of rows) {
    doc.font('regular').fontSize(BODY);
    const texts = table.columns.map((_, i) => cellText(row[i] ?? null));
    const height =
      Math.max(
        ...texts.map((t, i) =>
          doc.heightOfString(t || ' ', { width: (widths[i] as number) - PAD * 2 }),
        ),
      ) +
      PAD * 2;
    if (doc.y + height > bottom()) {
      doc.addPage();
      header();
      doc.font('regular').fontSize(BODY);
    }
    const y = doc.y;
    let x = MARGIN;
    doc.fillColor('#111111');
    texts.forEach((t, i) => {
      doc.text(t, x + PAD, y + PAD, { width: (widths[i] as number) - PAD * 2 });
      x += widths[i] as number;
    });
    doc
      .moveTo(MARGIN, y + height)
      .lineTo(MARGIN + width, y + height)
      .lineWidth(0.25)
      .strokeColor('#cccccc')
      .stroke();
    doc.y = y + height;
  }
  if (rows.length === 0)
    doc
      .font('regular')
      .fontSize(9)
      .fillColor('#444444')
      .text('Sin registros para los filtros aplicados.', MARGIN, doc.y + 6);

  const range = doc.bufferedPageRange();
  for (let index = 0; index < range.count; index += 1) {
    doc.switchToPage(range.start + index);
    // The footer sits inside the bottom margin; without this the text would open a new page.
    const margins = doc.page.margins;
    doc.page.margins = { ...margins, bottom: 0 };
    doc.font('regular').fontSize(8).fillColor('#444444');
    doc.text(
      `${stripControl(table.meta.companyName)}  |  Página ${index + 1} de ${range.count}`,
      MARGIN,
      doc.page.height - FOOTER_Y,
      { width, align: 'center', lineBreak: false },
    );
    doc.page.margins = margins;
  }
  doc.end();
  await done;
  return {
    bytes: new Uint8Array(Buffer.concat(chunks)),
    contentType: CONTENT_TYPES.pdf,
    extension: 'pdf',
  };
}
