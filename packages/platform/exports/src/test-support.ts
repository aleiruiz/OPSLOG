import { inflateRawSync } from 'node:zlib';
import type { ExportCell, ExportMeta, ExportTable } from './types.js';

export const META: ExportMeta = {
  companyName: 'Transportes Ñandú S.A.',
  generatedAt: new Date('2026-10-19T15:30:00.000Z'),
  timeZone: 'America/Mexico_City',
  authorLabel: 'Administrador (a1b2c3)',
  filterNames: ['Área', 'Estado'],
};

/** Texts that a spreadsheet would read as formulas, with the full-width variants and control characters. */
export const HOSTILE = [
  '=1+1',
  '+cmd',
  '-2',
  '@SUM(A1)',
  '\t=1',
  '\r=1',
  '＝1',
  '＋1',
  '－1',
  '＠x',
];

export function table(rows: readonly (readonly ExportCell[])[], title = 'Inventario'): ExportTable {
  return {
    title,
    columns: [
      { label: 'Texto', kind: 'text' },
      { label: 'Cantidad', kind: 'integer' },
      { label: 'Importe', kind: 'number' },
      { label: 'Día', kind: 'date' },
    ],
    rows,
    meta: META,
  };
}

/** Reads one entry of a zip through its central directory (no zip library: it proves what is stored). */
export function readZipEntry(bytes: Uint8Array, name: string): string {
  const buffer = Buffer.from(bytes);
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  for (let i = 0; i < count; i += 1) {
    const method = buffer.readUInt16LE(offset + 10);
    const size = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const entry = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (entry === name) {
      const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
      const data = buffer.subarray(start, start + size);
      return (method === 8 ? inflateRawSync(data) : data).toString('utf8');
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`zip entry not found: ${name}`);
}
