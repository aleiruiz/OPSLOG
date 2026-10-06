import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { DataKey, EncryptionContext, KmsPort } from './kms.js';

/**
 * PII protection (SPECS D23): envelope encryption with a KMS-held key plus an HMAC blind index for
 * exact-match lookup and uniqueness.
 *
 * `KmsPort` is the only thing a cloud adapter has to implement (AWS KMS: `GenerateDataKey`,
 * `Decrypt`, `GenerateMac`). AWS is deferred (ADR-0002), so the repository ships only
 * `LocalDevKms` (development and tests, never production) plus a contract suite
 * (`testing/kms-contract.ts`) that any future adapter must pass.
 *
 * Nothing in this module ever puts a plaintext value, a key or a ciphertext into an error message.
 */

/** Which record a ciphertext belongs to. It is bound into the ciphertext as authenticated data. */
export interface PiiContext {
  readonly tenantId: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly field: string;
}

export type PiiErrorCode = 'invalid_input' | 'invalid_sealed' | 'kms_failure';

/** Fixed-message failure of the cipher. It never carries a value, a key or a provider message. */
export class PiiError extends Error {
  public constructor(public readonly code: PiiErrorCode) {
    super(`PII operation failed: ${code}`);
    this.name = 'PiiError';
  }
}

export interface PiiCipher {
  /** Encrypts `plaintext` for the record in `context`. The result is a self-describing envelope string. */
  seal(context: PiiContext, plaintext: string): Promise<string>;
  /** Decrypts an envelope produced by `seal` for the very same context; any other context fails. */
  open(context: PiiContext, sealed: string): Promise<string>;
  /**
   * Blind index (lowercase hex HMAC-SHA-256) of an already normalized value, scoped to the tenant
   * and the field: equal inputs collide, nothing else can be learned from it without the key.
   */
  blindIndex(tenantId: string, field: string, normalized: string): Promise<string>;
}

export const SEALED_PREFIX = 'pii1.';
export const SEALED_PATTERN = /^pii1\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){3}$/;
export const BLIND_INDEX_PATTERN = /^[0-9a-f]{64}$/;
export const MAX_PLAINTEXT_BYTES = 1024;

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const FIELD = /^[a-z][a-z0-9_]{0,63}$/;
const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');
const unb64 = (text: string): Buffer => Buffer.from(text, 'base64url');

function checkContext(context: PiiContext): EncryptionContext {
  if (
    typeof context !== 'object' ||
    context === null ||
    !SEGMENT.test(context.tenantId) ||
    !SEGMENT.test(context.entityType) ||
    !SEGMENT.test(context.entityId) ||
    !FIELD.test(context.field)
  )
    throw new PiiError('invalid_input');
  return {
    tenantId: context.tenantId,
    entityType: context.entityType,
    entityId: context.entityId,
    field: context.field,
  };
}

/** Canonical authenticated data: fixed order, so the encryption context never depends on key order. */
const aadOf = (context: EncryptionContext): Buffer =>
  Buffer.from(
    JSON.stringify([
      'opslog.pii.v1',
      ...Object.keys(context)
        .sort()
        .map((key) => [key, context[key]]),
    ]),
  );

const wipe = (bytes: Uint8Array): void => {
  bytes.fill(0);
};

/**
 * Envelope encryption over any `KmsPort`: one data key per value, AES-256-GCM, with the record
 * context as authenticated data, so a ciphertext cannot be moved to another tenant, row or field.
 * Envelope: `pii1.<keyId>.<wrappedKey>.<iv>.<ciphertext||tag>` (base64url segments).
 */
export class EnvelopePiiCipher implements PiiCipher {
  public constructor(private readonly kms: KmsPort) {}

  public async seal(context: PiiContext, plaintext: string): Promise<string> {
    const encryptionContext = checkContext(context);
    const data = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : null;
    if (data === null || data.length === 0 || data.length > MAX_PLAINTEXT_BYTES)
      throw new PiiError('invalid_input');
    let key: DataKey;
    try {
      key = await this.kms.generateDataKey(encryptionContext);
    } catch {
      throw new PiiError('kms_failure');
    }
    try {
      if (key.plaintext.length !== 32 || !SEGMENT.test(key.keyId) || key.wrapped.length === 0)
        throw new PiiError('kms_failure');
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key.plaintext, iv);
      cipher.setAAD(aadOf(encryptionContext));
      const body = Buffer.concat([cipher.update(data), cipher.final(), cipher.getAuthTag()]);
      return `${SEALED_PREFIX}${b64(Buffer.from(key.keyId))}.${b64(key.wrapped)}.${b64(iv)}.${b64(body)}`;
    } finally {
      wipe(key.plaintext);
      wipe(data);
    }
  }

  public async open(context: PiiContext, sealed: string): Promise<string> {
    const encryptionContext = checkContext(context);
    if (typeof sealed !== 'string' || !SEALED_PATTERN.test(sealed))
      throw new PiiError('invalid_sealed');
    const [keyId, wrapped, iv, body] = sealed.slice(SEALED_PREFIX.length).split('.').map(unb64) as [
      Buffer,
      Buffer,
      Buffer,
      Buffer,
    ];
    if (iv.length !== 12 || body.length < 17 || wrapped.length === 0)
      throw new PiiError('invalid_sealed');
    let key: Uint8Array;
    try {
      key = await this.kms.decryptDataKey({
        keyId: keyId.toString('utf8'),
        wrapped,
        context: encryptionContext,
      });
    } catch {
      throw new PiiError('kms_failure');
    }
    try {
      if (key.length !== 32) throw new PiiError('kms_failure');
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(aadOf(encryptionContext));
      decipher.setAuthTag(body.subarray(body.length - 16));
      const plain = Buffer.concat([
        decipher.update(body.subarray(0, body.length - 16)),
        decipher.final(),
      ]);
      try {
        return plain.toString('utf8');
      } finally {
        wipe(plain);
      }
    } catch (error) {
      throw error instanceof PiiError ? error : new PiiError('invalid_sealed');
    } finally {
      wipe(key);
    }
  }

  public async blindIndex(tenantId: string, field: string, normalized: string): Promise<string> {
    if (
      !SEGMENT.test(tenantId) ||
      !FIELD.test(field) ||
      typeof normalized !== 'string' ||
      normalized.length === 0 ||
      Buffer.byteLength(normalized) > MAX_PLAINTEXT_BYTES
    )
      throw new PiiError('invalid_input');
    let mac: Uint8Array;
    try {
      mac = await this.kms.mac({
        tenantId,
        message: Buffer.from(JSON.stringify(['opslog.blind.v1', tenantId, field, normalized])),
      });
    } catch {
      throw new PiiError('kms_failure');
    }
    if (mac.length !== 32) throw new PiiError('kms_failure');
    return Buffer.from(mac).toString('hex');
  }
}
