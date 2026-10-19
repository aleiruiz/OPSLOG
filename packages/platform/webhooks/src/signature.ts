import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Headers of every delivery (SPECS §4.3, §7). */
export const EVENT_ID_HEADER = 'OPSLOG-Event-Id';
export const TIMESTAMP_HEADER = 'OPSLOG-Timestamp';
export const SIGNATURE_HEADER = 'OPSLOG-Signature';
export const SIGNATURE_VERSION = 'v1';
/** A receiver rejects a delivery whose timestamp is further than this from its own clock. */
export const REPLAY_TOLERANCE_SECONDS = 5 * 60;
export const SECRET_PREFIX = 'whsec_';

/** 32 random bytes, shown once. The value itself is the HMAC key. */
export function generateSecret(): string {
  return `${SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;
}

/** HMAC-SHA256 over `<timestamp>.<eventId>.<exact body bytes>`, lowercase hex. */
export function signatureOf(
  secret: string,
  timestamp: string,
  eventId: string,
  body: Uint8Array | string,
): string {
  return createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(`${timestamp}.${eventId}.`), Buffer.from(body)]))
    .digest('hex');
}

/** `v1=<hex>` for one secret; `v1=a,v1=b` while a rotated secret is still valid. */
export function signatureHeader(
  secrets: readonly string[],
  timestamp: string,
  eventId: string,
  body: Uint8Array | string,
): string {
  return secrets
    .map((secret) => `${SIGNATURE_VERSION}=${signatureOf(secret, timestamp, eventId, body)}`)
    .join(',');
}

export type VerifyFailure =
  | 'missing_headers'
  | 'bad_timestamp'
  | 'stale_timestamp'
  | 'bad_signature'
  | 'replayed';

export interface VerifyInput {
  /** Every secret that may still sign (the current one and, for 24 h after a rotation, the previous). */
  readonly secrets: readonly string[];
  /** Header names are compared case-insensitively. */
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** The raw bytes as received, before any JSON parsing. */
  readonly body: Uint8Array | string;
  /** Receiver's clock, in milliseconds. */
  readonly nowMs: number;
  readonly toleranceSeconds?: number;
  /** Deduplication by event id: return true when the id was already processed. */
  readonly seen?: (eventId: string) => boolean;
}

export type VerifyResult =
  | { readonly ok: true; readonly eventId: string }
  | { readonly ok: false; readonly reason: VerifyFailure };

const lower = (headers: VerifyInput['headers'], name: string): string | undefined => {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers))
    if (key.toLowerCase() === wanted) return value;
  return undefined;
};

/**
 * The receiver's side, as the documentation shows it: check the freshness of the timestamp, compare
 * the signature in constant time against every valid secret and drop an event id already seen.
 */
export function verifyWebhook(input: VerifyInput): VerifyResult {
  const eventId = lower(input.headers, EVENT_ID_HEADER);
  const timestamp = lower(input.headers, TIMESTAMP_HEADER);
  const header = lower(input.headers, SIGNATURE_HEADER);
  if (!eventId || !timestamp || !header) return { ok: false, reason: 'missing_headers' };
  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: 'bad_timestamp' };
  const tolerance = input.toleranceSeconds ?? REPLAY_TOLERANCE_SECONDS;
  if (Math.abs(input.nowMs / 1000 - Number(timestamp)) > tolerance)
    return { ok: false, reason: 'stale_timestamp' };
  const offered = header
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${SIGNATURE_VERSION}=`))
    .map((part) => part.slice(SIGNATURE_VERSION.length + 1));
  const matches = input.secrets.some((secret) => {
    const expected = Buffer.from(signatureOf(secret, timestamp, eventId, input.body), 'hex');
    return offered.some((hex) => {
      const given = Buffer.from(hex, 'hex');
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
  });
  if (!matches) return { ok: false, reason: 'bad_signature' };
  if (input.seen?.(eventId)) return { ok: false, reason: 'replayed' };
  return { ok: true, eventId };
}
