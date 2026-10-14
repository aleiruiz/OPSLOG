import { exifCaptureTime } from './exif';

/** Photos are re-encoded to about this size before they are sent (US-030, ADR-0014). */
export const COMPRESS_TARGET_BYTES = 2 * 1024 * 1024;
/** SPECS §7: 15 MB for images, 25 MB for PDF, DOCX and XLSX. */
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const isPhoto = (type: string): boolean => PHOTO_TYPES.includes(type);
export const limitFor = (type: string): number =>
  type.startsWith('image/') ? MAX_IMAGE_BYTES : MAX_DOCUMENT_BYTES;

/**
 * Re-encodes an image into a JPEG of at most `target` bytes (a PNG when the image has transparency, because
 * a JPEG has no alpha and would turn it black); rejects when the browser cannot.
 */
export type Compressor = (file: Blob, target: number) => Promise<Blob>;

/** The file as it will be sent. */
export interface Prepared {
  readonly blob: Blob;
  readonly name: string;
  readonly contentType: string;
  /** Declared to the server; informative, not proof. */
  readonly clientCompressed: boolean;
  readonly capturedAt: string | null;
}

/** True when any pixel is not fully opaque: such an image must stay a PNG. */
function hasTransparency(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
): boolean {
  const { data } = context.getImageData(0, 0, width, height);
  for (let index = 3; index < data.length; index += 4) if (data[index] !== 255) return true;
  return false;
}

/** JPEG, then lower quality, then smaller, until it fits. A `canvas` is all it needs. */
export const canvasCompress: Compressor = async (file, target) => {
  const bitmap = await createImageBitmap(file);
  try {
    return await fitJpeg(bitmap, target);
  } finally {
    bitmap.close();
  }
};

async function fitJpeg(bitmap: ImageBitmap, target: number): Promise<Blob> {
  let scale = Math.min(1, 2560 / Math.max(bitmap.width, bitmap.height));
  for (let round = 0; round < 8; round += 1) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('no canvas');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const png = hasTransparency(context, canvas.width, canvas.height);
    // A PNG has no quality to lower: only the size shrinks, round after round.
    for (const quality of png ? [undefined] : [0.85, 0.7, 0.55]) {
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, png ? 'image/png' : 'image/jpeg', quality),
      );
      if (blob && blob.size <= target) return blob;
    }
    scale *= 0.75;
  }
  throw new Error('could not reach the target size');
}

const readBytes = (blob: Blob): Promise<ArrayBuffer> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.readAsArrayBuffer(blob);
  });

/** When the photo was taken: the EXIF of a JPEG, else the file's own date. Read before any re-encoding. */
export async function captureTime(file: File): Promise<string | null> {
  if (file.type === 'image/jpeg') {
    try {
      const head = new Uint8Array(await readBytes(file.slice(0, 131_072)));
      const exif = exifCaptureTime(head);
      if (exif !== null) return exif;
    } catch {
      // Unreadable header: fall back to the file date.
    }
  }
  return file.lastModified > 0 ? new Date(file.lastModified).toISOString() : null;
}

const reencodedName = (name: string, png: boolean): string =>
  `${name.replace(/\.[^./\\]+$/, '')}.${png ? 'png' : 'jpg'}`;

/**
 * Gets a file ready to send. A photo (JPEG, PNG or WebP) above about 2 MB is compressed in the browser;
 * PDF, DOCX and XLSX are never touched. If compression fails the original goes as it is, within the SPECS §7
 * limits that the caller checks next. The capture date is read first.
 */
export async function prepareFile(
  file: File,
  compress: Compressor = canvasCompress,
): Promise<Prepared> {
  const capturedAt = await captureTime(file);
  if (isPhoto(file.type) && file.size > COMPRESS_TARGET_BYTES) {
    try {
      const blob = await compress(file, COMPRESS_TARGET_BYTES);
      if (blob.size < file.size) {
        const png = blob.type === 'image/png';
        return {
          blob,
          name: reencodedName(file.name, png),
          contentType: png ? 'image/png' : 'image/jpeg',
          clientCompressed: true,
          capturedAt,
        };
      }
    } catch {
      // Falls through to the original.
    }
  }
  return {
    blob: file,
    name: file.name,
    contentType: file.type,
    clientCompressed: false,
    capturedAt,
  };
}

export const toBase64 = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.readAsDataURL(blob);
  });
