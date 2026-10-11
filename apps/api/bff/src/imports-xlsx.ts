import { Buffer } from 'node:buffer';
import yauzl from 'yauzl';
import sax from 'sax';
import {
  BFF_IMPORT_TEMPLATES,
  type BffImportEntity,
} from '../../../../packages/contracts/src/index.js';

const MAX_ARCHIVE_BYTES = 400_000;
const MAX_ENTRIES = 32;
const MAX_EXPANDED_BYTES = 5_000_000;
const MAX_ENTRY_BYTES = 2_500_000;
const MAX_XML_BYTES = 2_000_000;
const MAX_ROWS = 500;
const MAX_COLUMNS = 16;
const MAX_CELL_LENGTH = 200;
const ALLOWED_FILES = new Set([
  '[Content_Types].xml',
  '_rels/.rels',
  'docProps/app.xml',
  'docProps/core.xml',
  'xl/workbook.xml',
  'xl/_rels/workbook.xml.rels',
  'xl/worksheets/sheet1.xml',
  'xl/sharedStrings.xml',
  'xl/styles.xml',
  'xl/theme/theme1.xml',
]);

export class InvalidXlsx extends Error {
  public constructor() {
    super('Invalid XLSX');
    this.name = 'InvalidXlsx';
  }
}

const invalid = (): never => {
  throw new InvalidXlsx();
};

function readZip(buffer: Buffer): Promise<ReadonlyMap<string, Buffer>> {
  if (buffer.length === 0 || buffer.length > MAX_ARCHIVE_BYTES)
    return Promise.reject(new InvalidXlsx());
  return yauzl
    .fromBufferPromise(buffer, {
      lazyEntries: true,
      autoClose: false,
      validateEntrySizes: true,
      strictFileNames: true,
    })
    .then(async (zip) => {
      const files = new Map<string, Buffer>();
      let total = 0;
      try {
        if (zip.entryCount < 4 || zip.entryCount > MAX_ENTRIES) invalid();
        for await (const entry of zip.eachEntry()) {
          const name = entry.fileName;
          if (
            !name ||
            name.includes('\\') ||
            name.startsWith('/') ||
            name.split('/').some((part) => part === '..' || part === '.') ||
            name.endsWith('/') ||
            !ALLOWED_FILES.has(name) ||
            files.has(name) ||
            entry.isEncrypted() ||
            ![0, 8].includes(entry.compressionMethod) ||
            !Number.isSafeInteger(entry.uncompressedSize) ||
            entry.uncompressedSize < 0 ||
            entry.uncompressedSize > MAX_ENTRY_BYTES
          )
            invalid();
          total += entry.uncompressedSize;
          if (total > MAX_EXPANDED_BYTES) invalid();
          const stream = await zip.openReadStreamPromise(entry);
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of stream) {
            const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += part.length;
            if (size > entry.uncompressedSize || size > MAX_ENTRY_BYTES) invalid();
            chunks.push(part);
          }
          if (size !== entry.uncompressedSize) invalid();
          files.set(name, Buffer.concat(chunks, size));
        }
        if (
          !files.has('[Content_Types].xml') ||
          !files.has('xl/workbook.xml') ||
          !files.has('xl/_rels/workbook.xml.rels') ||
          !files.has('xl/worksheets/sheet1.xml')
        )
          invalid();
        return files;
      } finally {
        zip.close();
      }
    })
    .catch(() => invalid());
}

function xmlText(bytes: Buffer): string {
  if (bytes.length > MAX_XML_BYTES) return invalid();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return invalid();
  }
}

function parseXml(
  text: string,
  onOpen: (name: string, attrs: Readonly<Record<string, string>>) => void,
  onText: (text: string) => void,
  onClose: (name: string) => void,
): void {
  const parser = sax.parser(true);
  parser.onopentag = (tag) => onOpen(tag.name, tag.attributes as Readonly<Record<string, string>>);
  parser.ontext = onText;
  parser.onclosetag = onClose;
  parser.ondoctype = invalid;
  parser.onerror = (error) => {
    throw error;
  };
  try {
    parser.write(text).close();
  } catch {
    invalid();
  }
}

function validatePackage(files: ReadonlyMap<string, Buffer>): void {
  const types = xmlText(files.get('[Content_Types].xml')!);
  if (/macroenabled|vbaproject/i.test(types)) invalid();
  for (const name of ['_rels/.rels', 'xl/_rels/workbook.xml.rels']) {
    const bytes = files.get(name);
    if (!bytes) continue;
    parseXml(
      xmlText(bytes),
      (tag, attrs) => {
        if (tag !== 'Relationship') return;
        if ((attrs['TargetMode'] ?? '').toLowerCase() === 'external') invalid();
        const target = attrs['Target'] ?? '';
        if (!target || target.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(target)) invalid();
        if (target.split('/').some((part) => part === '..' || part === '.')) invalid();
      },
      () => undefined,
      () => undefined,
    );
  }
  let sheets = 0;
  let sheetTarget = '';
  parseXml(
    xmlText(files.get('xl/workbook.xml')!),
    (tag, attrs) => {
      if (tag === 'definedNames') invalid();
      if (tag === 'sheet') {
        sheets += 1;
        if (sheets > 1 || (attrs['state'] !== undefined && attrs['state'] !== 'visible')) invalid();
        sheetTarget = attrs['r:id'] ?? '';
        if (!sheetTarget) invalid();
      }
    },
    () => undefined,
    () => undefined,
  );
  if (sheets !== 1 || sheetTarget !== 'rId1') invalid();
  let worksheetRelation = false;
  parseXml(
    xmlText(files.get('xl/_rels/workbook.xml.rels')!),
    (tag, attrs) => {
      if (tag !== 'Relationship') return;
      const target = (attrs['Target'] ?? '').replace(/^\//, '');
      if (
        attrs['Id'] === sheetTarget &&
        target === 'worksheets/sheet1.xml' &&
        attrs['Type']?.endsWith('/worksheet')
      )
        worksheetRelation = true;
      if (
        !['worksheets/sheet1.xml', 'sharedStrings.xml', 'styles.xml', 'theme/theme1.xml'].includes(
          target,
        )
      )
        invalid();
    },
    () => undefined,
    () => undefined,
  );
  if (!worksheetRelation) invalid();
}

function sharedStrings(text: string): string[] {
  const result: string[] = [];
  let inItem = false;
  let inText = false;
  let phonetic = false;
  let value = '';
  parseXml(
    text,
    (tag) => {
      if (tag === 'si') {
        inItem = true;
        value = '';
      } else if (tag === 'rPh') phonetic = true;
      else if (tag === 't' && inItem && !phonetic) inText = true;
    },
    (part) => {
      if (inText) value += part;
    },
    (tag) => {
      if (tag === 't') inText = false;
      else if (tag === 'rPh') phonetic = false;
      else if (tag === 'si') {
        inItem = false;
        result.push(value);
        if (result.length > MAX_ROWS * MAX_COLUMNS) invalid();
      }
    },
  );
  return result;
}

interface Cell {
  readonly value: string;
  readonly numeric: boolean;
}

function columnIndex(address: string): { row: number; column: number } {
  const match = /^([A-P]+)([1-9][0-9]*)$/.exec(address);
  if (!match) return invalid();
  let column = 0;
  for (const letter of match[1]!) column = column * 26 + letter.charCodeAt(0) - 64;
  const row = Number(match[2]);
  if (column > MAX_COLUMNS || row > MAX_ROWS + 1) return invalid();
  return { row, column };
}

function worksheet(text: string, strings: readonly string[]): Map<number, Map<number, Cell>> {
  const rows = new Map<number, Map<number, Cell>>();
  let currentRow = 0;
  let currentColumn = 0;
  let currentType = '';
  let value = '';
  let inValue = false;
  let inInlineText = false;
  let inPhonetic = false;
  let formula = false;
  let cells = 0;
  parseXml(
    text,
    (tag, attrs) => {
      if (tag === 'row') {
        if (attrs['hidden'] === '1' || attrs['hidden'] === 'true') invalid();
      } else if (tag === 'col' && (attrs['hidden'] === '1' || attrs['hidden'] === 'true'))
        invalid();
      else if (tag === 'c') {
        const position = columnIndex(attrs['r'] ?? '');
        currentRow = position.row;
        currentColumn = position.column;
        currentType = attrs['t'] ?? 'n';
        value = '';
        formula = false;
        cells += 1;
        if (cells > (MAX_ROWS + 1) * MAX_COLUMNS) invalid();
      } else if (tag === 'f') formula = true;
      else if (tag === 'v') inValue = true;
      else if (tag === 't' && currentType === 'inlineStr' && !inPhonetic) inInlineText = true;
      else if (tag === 'rPh') inPhonetic = true;
    },
    (part) => {
      if (inValue || inInlineText) value += part;
    },
    (tag) => {
      if (tag === 'v') inValue = false;
      else if (tag === 't') inInlineText = false;
      else if (tag === 'rPh') inPhonetic = false;
      else if (tag === 'c') {
        if (formula || !['s', 'inlineStr', 'str', 'n'].includes(currentType)) invalid();
        let textValue = value;
        let numeric = currentType === 'n';
        if (currentType === 's') {
          const index = Number(value);
          if (!Number.isSafeInteger(index) || index < 0 || index >= strings.length) invalid();
          textValue = strings[index]!;
          numeric = false;
        }
        if (textValue.length > MAX_CELL_LENGTH) invalid();
        let row = rows.get(currentRow);
        if (!row) {
          row = new Map();
          rows.set(currentRow, row);
        }
        if (row.has(currentColumn)) invalid();
        row.set(currentColumn, { value: textValue, numeric });
      }
    },
  );
  return rows;
}

function excelDate(serial: string): string {
  if (!/^\d{1,6}(?:\.0+)?$/.test(serial)) return invalid();
  const days = Number(serial);
  if (!Number.isSafeInteger(days) || days < 18_263 || days > 2_958_465) return invalid();
  return new Date(Date.UTC(1899, 11, 30 + days)).toISOString().slice(0, 10);
}

export async function parseXlsx(
  buffer: Buffer,
  entity: BffImportEntity,
): Promise<readonly Readonly<Record<string, string>>[]> {
  const files = await readZip(buffer);
  validatePackage(files);
  const stringsFile = files.get('xl/sharedStrings.xml');
  const strings = stringsFile ? sharedStrings(xmlText(stringsFile)) : [];
  const sheet = worksheet(xmlText(files.get('xl/worksheets/sheet1.xml')!), strings);
  const headerRow = sheet.get(1);
  if (!headerRow || headerRow.size === 0 || headerRow.size > MAX_COLUMNS) return invalid();
  const width = Math.max(...headerRow.keys());
  const columns = BFF_IMPORT_TEMPLATES[entity];
  const allowed = new Set<string>([...columns.required, ...columns.optional]);
  const names = Array.from({ length: width }, (_, i) => headerRow.get(i + 1)?.value.trim() ?? '');
  if (
    new Set(names).size !== names.length ||
    names.some((name) => !allowed.has(name)) ||
    columns.required.some((name) => !names.includes(name))
  )
    return invalid();
  const result: Record<string, string>[] = [];
  for (const [rowNumber, cells] of [...sheet].sort(([a], [b]) => a - b)) {
    if (rowNumber === 1) continue;
    const row: Record<string, string> = {};
    for (let column = 1; column <= width; column += 1) {
      const cell = cells.get(column);
      if (!cell || cell.value === '') continue;
      const key = names[column - 1]!;
      row[key] =
        cell.numeric && ['registeredOn', 'hireDate', 'licenseExpiresOn'].includes(key)
          ? excelDate(cell.value)
          : cell.value;
    }
    if (Object.keys(row).length > 0) result.push(row);
    if (result.length > MAX_ROWS) return invalid();
  }
  if (result.length === 0) return invalid();
  return result;
}

export function decodeXlsxBase64(value: unknown): Buffer {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 4 * Math.ceil(MAX_ARCHIVE_BYTES / 3) ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
    return invalid();
  const buffer = Buffer.from(value, 'base64');
  if (
    buffer.length === 0 ||
    buffer.length > MAX_ARCHIVE_BYTES ||
    buffer.toString('base64') !== value
  )
    return invalid();
  return buffer;
}
