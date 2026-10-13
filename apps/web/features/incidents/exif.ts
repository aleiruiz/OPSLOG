/**
 * The moment a JPEG photo was taken, from its EXIF block (DateTimeOriginal, else the digitized or file
 * date). It is read before compressing, because re-encoding drops the EXIF block. EXIF stores the camera's
 * wall time without a zone, so it is read in the browser's zone. Returns `null` when there is none.
 */
export function exifCaptureTime(bytes: Uint8Array): string | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12 || view.getUint16(0) !== 0xffd8) return null;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (view.getUint8(offset) !== 0xff) return null;
    const marker = view.getUint8(offset + 1);
    const size = view.getUint16(offset + 2);
    if (marker === 0xe1 && ascii(bytes, offset + 4, 4) === 'Exif')
      return readTiff(view, bytes, offset + 10);
    if (marker === 0xda || size < 2) return null;
    offset += 2 + size;
  }
  return null;
}

const ascii = (bytes: Uint8Array, start: number, length: number): string =>
  String.fromCharCode(...bytes.subarray(start, start + length));

function readTiff(view: DataView, bytes: Uint8Array, tiff: number): string | null {
  if (tiff + 8 > bytes.length) return null;
  const little = ascii(bytes, tiff, 2) === 'II';
  const u16 = (at: number) => view.getUint16(at, little);
  const u32 = (at: number) => view.getUint32(at, little);
  /** Entries of the IFD at `ifd` (relative to the TIFF header): tag -> position of its 12-byte entry. */
  const entries = (ifd: number): Map<number, number> => {
    const found = new Map<number, number>();
    const start = tiff + ifd;
    if (start + 2 > bytes.length) return found;
    const count = u16(start);
    for (let index = 0; index < count && start + 2 + index * 12 + 12 <= bytes.length; index += 1)
      found.set(u16(start + 2 + index * 12), start + 2 + index * 12);
    return found;
  };
  const text = (entry: number): string | null => {
    const length = u32(entry + 4);
    const at = length > 4 ? tiff + u32(entry + 8) : entry + 8;
    return at + 19 <= bytes.length ? ascii(bytes, at, 19) : null;
  };
  const zero = entries(u32(tiff + 4));
  const exifPointer = zero.get(0x8769);
  const exif =
    exifPointer === undefined ? new Map<number, number>() : entries(u32(exifPointer + 8));
  const entry = exif.get(0x9003) ?? exif.get(0x9004) ?? zero.get(0x0132);
  const stamp = entry === undefined ? null : text(entry);
  const match =
    stamp === null ? null : /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(stamp);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const date = new Date(year, month - 1, day, hour, minute, second);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
