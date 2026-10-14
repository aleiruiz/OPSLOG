import { createPublicKey, verify, type JsonWebKey, type KeyObject } from 'node:crypto';

export type JwtClaims = Readonly<Record<string, unknown>>;

export interface JwkSet {
  readonly keys: readonly JsonWebKey[];
}

const b64urlJson = (part: string): unknown => {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) throw new Error('malformed token');
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown;
};

const asRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('malformed token');
  return value as Record<string, unknown>;
};

/** Key id named by the token header, read before the signature is checked only to pick the key. */
export function jwtKeyId(token: string): string {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const header = asRecord(b64urlJson(parts[0] as string));
  if (header['alg'] !== 'RS256' || typeof header['kid'] !== 'string' || !header['kid'])
    throw new Error('unsupported token');
  return header['kid'];
}

/**
 * Checks an RS256 signature against the given key and returns the payload. Only RS256 is accepted
 * (never `none` or a symmetric algorithm); claims are the caller's to validate.
 */
export function verifyRs256(token: string, key: JsonWebKey): JwtClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  jwtKeyId(token);
  if (key.kty !== 'RSA') throw new Error('unsupported key');
  const publicKey: KeyObject = createPublicKey({ key, format: 'jwk' });
  const signature = Buffer.from(parts[2] as string, 'base64url');
  if (!verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, signature))
    throw new Error('bad signature');
  return asRecord(b64urlJson(parts[1] as string));
}
