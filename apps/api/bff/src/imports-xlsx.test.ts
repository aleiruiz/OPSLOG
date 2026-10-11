import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodeXlsxBase64, InvalidXlsx, parseXlsx } from './imports-xlsx.js';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let value = n;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function zip(files: Readonly<Record<string, string>>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const filename = Buffer.from(name);
    const plain = Buffer.from(text);
    const compressed = deflateRawSync(plain);
    const crc = crc32(plain);
    const local = Buffer.alloc(30 + filename.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(plain.length, 22);
    local.writeUInt16LE(filename.length, 26);
    filename.copy(local, 30);
    locals.push(local, compressed);

    const record = Buffer.alloc(46 + filename.length);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(8, 10);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(compressed.length, 20);
    record.writeUInt32LE(plain.length, 24);
    record.writeUInt16LE(filename.length, 28);
    record.writeUInt32LE(offset, 42);
    filename.copy(record, 46);
    central.push(record);
    offset += local.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const packageFiles = (
  sheet: string,
  workbook = '<workbook xmlns:r="r"><sheets><sheet name="Import" sheetId="1" r:id="rId1"/></sheets></workbook>',
  workbookRels = '<Relationships><Relationship Id="rId1" Type="x/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
) => ({
  '[Content_Types].xml':
    '<Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
  '_rels/.rels':
    '<Relationships><Relationship Id="rId0" Type="x/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  'xl/workbook.xml': workbook,
  'xl/_rels/workbook.xml.rels': workbookRels,
  'xl/worksheets/sheet1.xml': sheet,
});

const cell = (address: string, value: string) =>
  `<c r="${address}" t="inlineStr"><is><t>${value}</t></is></c>`;

describe('bounded XLSX reader', () => {
  it('reads the first visible worksheet as rows and normalizes date serials', async () => {
    const headers = [
      'economicNumber',
      'plate',
      'make',
      'model',
      'year',
      'areaId',
      'odometerKm',
      'registeredOn',
    ];
    const cells = headers
      .map((header, index) => cell(`${String.fromCharCode(65 + index)}1`, header))
      .join('');
    const values = ['E-01', 'ABC123', 'Marca', 'Modelo', '2024', 'area-id', '10', '45292'];
    const body = values
      .map((value, index) =>
        index === 7
          ? `<c r="H2"><v>${value}</v></c>`
          : cell(`${String.fromCharCode(65 + index)}2`, value),
      )
      .join('');
    const result = await parseXlsx(
      zip(
        packageFiles(
          `<worksheet><sheetData><row r="1">${cells}</row><row r="2">${body}</row></sheetData></worksheet>`,
        ),
      ),
      'vehicle',
    );
    expect(result).toEqual([
      {
        economicNumber: 'E-01',
        plate: 'ABC123',
        make: 'Marca',
        model: 'Modelo',
        year: '2024',
        areaId: 'area-id',
        odometerKm: '10',
        registeredOn: '2024-01-01',
      },
    ]);
  });

  it('rejects formulas instead of importing their cached values', async () => {
    const header = ['economicNumber', 'plate', 'make', 'model', 'year', 'areaId', 'odometerKm']
      .map((name, index) => cell(`${String.fromCharCode(65 + index)}1`, name))
      .join('');
    const row = ['E-01', 'ABC123', 'Marca', 'Modelo', '2024', 'area-id']
      .map((value, index) => cell(`${String.fromCharCode(65 + index)}2`, value))
      .join('');
    const formula = '<c r="G2"><f>1+1</f><v>2</v></c>';
    await expect(
      parseXlsx(
        zip(
          packageFiles(
            `<worksheet><sheetData><row r="1">${header}</row><row r="2">${row}${formula}</row></sheetData></worksheet>`,
          ),
        ),
        'vehicle',
      ),
    ).rejects.toBeInstanceOf(InvalidXlsx);
  });

  it('rejects external relationships and hidden worksheets', async () => {
    const sheet = '<worksheet><sheetData><row r="1"/></sheetData></worksheet>';
    await expect(
      parseXlsx(
        zip(
          packageFiles(
            sheet,
            undefined,
            '<Relationships><Relationship Id="rId1" Type="x/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="https://example.test" TargetMode="External"/></Relationships>',
          ),
        ),
        'vehicle',
      ),
    ).rejects.toBeInstanceOf(InvalidXlsx);
    await expect(
      parseXlsx(
        zip(
          packageFiles(
            sheet,
            '<workbook xmlns:r="r"><sheets><sheet name="Import" sheetId="1" state="hidden" r:id="rId1"/></sheets></workbook>',
          ),
        ),
        'vehicle',
      ),
    ).rejects.toBeInstanceOf(InvalidXlsx);
  });

  it('requires canonical bounded base64', () => {
    expect(decodeXlsxBase64(Buffer.from('small').toString('base64'))).toEqual(Buffer.from('small'));
    expect(decodeXlsxBase64(Buffer.alloc(400_000).toString('base64'))).toHaveLength(400_000);
    expect(() => decodeXlsxBase64(Buffer.alloc(400_001).toString('base64'))).toThrow(InvalidXlsx);
    expect(() => decodeXlsxBase64('not base64')).toThrow(InvalidXlsx);
  });
});
