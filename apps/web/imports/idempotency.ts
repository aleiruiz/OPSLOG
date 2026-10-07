import { IDEMPOTENCY_KEY } from './rules';

/**
 * A fresh idempotency key for one import attempt: 24 random bytes in hex behind a short prefix (50 characters, inside
 * the 8 to 64 the server accepts). It never carries data from the file. Web Crypto is used when the browser has it.
 */
export function newIdempotencyKey(random: () => Uint8Array = defaultRandom): string {
  const bytes = random();
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  const key = `imp-${hex}`;
  return IDEMPOTENCY_KEY.test(key) ? key : `imp-${hex.padEnd(8, '0').slice(0, 60)}`;
}

function defaultRandom(): Uint8Array {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}
