import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { HOSTILE, readZipEntry, table } from './test-support.js';
import { renderXlsx } from './xlsx.js';

async function load(bytes: Uint8Array): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(bytes) as never);
  return workbook;
}

describe('renderXlsx', () => {
  it('types every cell: text, integer, number and date', async () => {
    const out = await renderXlsx(table([['Camión', 3, 1.25, '2026-10-19']]));
    expect(out.extension).toBe('xlsx');
    const sheet = (await load(out.bytes)).getWorksheet('Reporte') as ExcelJS.Worksheet;
    expect(sheet.getRow(1).values).toEqual([undefined, 'Texto', 'Cantidad', 'Importe', 'Día']);
    const row = sheet.getRow(2);
    expect(row.getCell(1).value).toBe('Camión');
    expect(row.getCell(2).value).toBe(3);
    expect(row.getCell(3).value).toBe(1.25);
    expect((row.getCell(4).value as Date).toISOString()).toBe('2026-10-19T00:00:00.000Z');
    expect(row.getCell(4).numFmt).toBe('yyyy-mm-dd');
  });

  it('prefixes formula-like text and never writes a formula', async () => {
    const out = await renderXlsx(table(HOSTILE.map((value) => [value, 1, 2, null] as const)));
    const sheet = (await load(out.bytes)).getWorksheet('Reporte') as ExcelJS.Worksheet;
    for (const [index, value] of HOSTILE.entries()) {
      const cell = sheet.getRow(index + 2).getCell(1);
      // XML folds a carriage return into a line feed; the guard prefix is what matters.
      expect(cell.value).toBe(`'${value}`.replace('\r', '\n'));
      expect(cell.type).toBe(ExcelJS.ValueType.String);
    }
    // Inspect the bytes: no sheet cell carries a formula element.
    expect(readZipEntry(out.bytes, 'xl/worksheets/sheet1.xml')).not.toMatch(/<f[ >]/);
  });

  it('keeps a date column text that is not a day as guarded text, and drops non-finite numbers', async () => {
    const out = await renderXlsx(table([['x', 1, Number.NaN, '=bad']]));
    const sheet = (await load(out.bytes)).getWorksheet('Reporte') as ExcelJS.Worksheet;
    expect(sheet.getRow(2).getCell(3).value).toBeNull();
    expect(sheet.getRow(2).getCell(4).value).toBe("'=bad");
  });

  it('streams 5.000 rows with a freeze pane, a filter and the author as creator', async () => {
    const many = Array.from(
      { length: 5000 },
      (_, i) => [`fila ${i}`, i, i / 4, '2026-01-02'] as const,
    );
    const out = await renderXlsx(table(many));
    const workbook = await load(out.bytes);
    const sheet = workbook.getWorksheet('Reporte') as ExcelJS.Worksheet;
    expect(sheet.rowCount).toBe(5001);
    expect(sheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
    expect(sheet.autoFilter).toBeTruthy();
    expect(workbook.creator).toBe('Administrador (a1b2c3)');
  });

  it('writes an empty table with only the header', async () => {
    const sheet = (await load((await renderXlsx(table([]))).bytes)).getWorksheet(
      'Reporte',
    ) as ExcelJS.Worksheet;
    expect(sheet.rowCount).toBe(1);
  });
});
