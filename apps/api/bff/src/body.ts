import { singleHeader, type BffRequest, type HeaderValue } from './http.js';

export class BodyTooLarge extends Error {
  public constructor() {
    super('Payload too large');
    this.name = 'BodyTooLarge';
  }
}

/** Declared length from `Content-Length`; null when absent, NaN-like or negative values read as invalid. */
export function declaredLength(
  headers: Readonly<Record<string, HeaderValue>>,
): number | null | 'invalid' {
  const raw = singleHeader(headers, 'content-length');
  if (raw === undefined) return headers['content-length'] === undefined ? null : 'invalid';
  if (!/^\d{1,12}$/.test(raw)) return 'invalid';
  return Number(raw);
}

/** `application/json`, optionally with `charset=utf-8`; anything else (including multipart and text/plain) is refused. */
export function isJsonContentType(value: string | undefined): boolean {
  if (value === undefined) return false;
  const [type, ...params] = value.split(';').map((part) => part.trim().toLowerCase());
  if (type !== 'application/json') return false;
  return params.every((param) => param === 'charset=utf-8' || param === 'charset="utf-8"');
}

/**
 * Reads the whole body, refusing to buffer more than `limit` bytes: the stream is abandoned as soon
 * as the limit is crossed, whatever `Content-Length` claimed.
 */
export async function readBody(request: BffRequest, limit: number): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request.body) {
    size += chunk.byteLength;
    if (size > limit) throw new BodyTooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export class InvalidBody extends Error {
  public constructor() {
    super('Invalid body');
    this.name = 'InvalidBody';
  }
}

/** Parses a strict JSON object: valid UTF-8, a plain object and only the allowed properties. */
export function parseObject(
  bytes: Uint8Array,
  allowed: readonly string[],
  required: readonly string[] = allowed,
): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new InvalidBody();
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new InvalidBody();
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => !allowed.includes(key))) throw new InvalidBody();
  if (required.some((key) => !Object.hasOwn(record, key))) throw new InvalidBody();
  return record;
}

export function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max)
    throw new InvalidBody();
  return value;
}
