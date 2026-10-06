import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { KmsError, type DataKey, type EncryptionContext, type KmsPort } from './kms.js';

export interface LocalDevKmsOptions {
  /** Master key material, at least 32 bytes. It comes from configuration, never from the repository. */
  readonly masterKey: Uint8Array;
  /**
   * Deployment mode the caller is running in. `production` is refused, as is a process that
   * announces production through `NODE_ENV` or `OPSLOG_ENV`: this class is a development and test
   * stand-in for a real KMS and is not a key-management system.
   */
  readonly environment: string;
  /** Label stored in every wrapped key. Defaults to `local-dev-kms`. */
  readonly keyId?: string;
  /** Random source; tests inject a deterministic one. Defaults to `crypto.randomBytes`. */
  readonly random?: (size: number) => Uint8Array;
}

const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const TENANT = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const PRODUCTION = /^(?:production|prod)$/i;
const MAX_MESSAGE_BYTES = 4096;

const canonical = (context: EncryptionContext, keyId: string): Buffer =>
  Buffer.from(
    JSON.stringify([
      'opslog.local-dev-kms.v1',
      keyId,
      ...Object.keys(context)
        .sort()
        .map((key) => [key, context[key]]),
    ]),
  );

/**
 * Local, offline `KmsPort` for development and automated tests (AWS is deferred, ADR-0002).
 *
 * Data keys are wrapped with AES-256-GCM under a subkey of the configured master key and bound to
 * the encryption context; blind-index MACs use a per-tenant subkey. It offers no rotation, no
 * access policy and no audit, so it must never protect real data: construction fails in a
 * production-mode configuration. The master key must be supplied by the caller (configuration or a
 * test constant); `ephemeral()` makes a random one that dies with the process.
 */
export class LocalDevKms implements KmsPort {
  private readonly wrapKey: Buffer;
  private readonly macKey: Buffer;
  private readonly keyId: string;
  private readonly random: (size: number) => Uint8Array;

  public constructor(options: LocalDevKmsOptions) {
    LocalDevKms.assertNotProduction(options.environment);
    if (!(options.masterKey instanceof Uint8Array) || options.masterKey.length < 32)
      throw new Error('LocalDevKms requires a master key of at least 32 bytes');
    const keyId = options.keyId ?? 'local-dev-kms';
    if (!KEY_ID.test(keyId)) throw new Error('LocalDevKms key id is invalid');
    const derive = (info: string): Buffer =>
      Buffer.from(hkdfSync('sha256', options.masterKey, Buffer.alloc(0), `opslog.${info}`, 32));
    this.wrapKey = derive('local-dev-kms.wrap');
    this.macKey = derive('local-dev-kms.mac');
    this.keyId = keyId;
    this.random = options.random ?? ((size) => randomBytes(size));
  }

  /** Throws when the deployment mode (argument or process environment) is production. */
  public static assertNotProduction(
    environment: string,
    env: Readonly<Record<string, string | undefined>> = process.env,
  ): void {
    const announced = [environment, env['NODE_ENV'], env['OPSLOG_ENV']];
    if (announced.some((value) => typeof value === 'string' && PRODUCTION.test(value.trim())))
      throw new Error('LocalDevKms must not be used in production');
  }

  /** A KMS with a random master key: nothing sealed with it survives the process. */
  public static ephemeral(environment: string): LocalDevKms {
    return new LocalDevKms({ masterKey: randomBytes(32), environment });
  }

  /** Builds the KMS from a base64 master key taken from configuration. */
  public static fromBase64(masterKeyBase64: string, environment: string): LocalDevKms {
    return new LocalDevKms({ masterKey: Buffer.from(masterKeyBase64, 'base64'), environment });
  }

  public async generateDataKey(context: EncryptionContext): Promise<DataKey> {
    const plaintext = this.random(32);
    const iv = this.random(12);
    if (plaintext.length !== 32 || iv.length !== 12) throw new KmsError('unavailable');
    const cipher = createCipheriv('aes-256-gcm', this.wrapKey, iv);
    cipher.setAAD(canonical(context, this.keyId));
    const sealed = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    return {
      keyId: this.keyId,
      plaintext: Uint8Array.from(plaintext),
      wrapped: Buffer.concat([iv, sealed]),
    };
  }

  public async decryptDataKey(input: {
    readonly keyId: string;
    readonly wrapped: Uint8Array;
    readonly context: EncryptionContext;
  }): Promise<Uint8Array> {
    if (input.keyId !== this.keyId) throw new KmsError('denied');
    // iv (12) + data key (32) + tag (16)
    if (input.wrapped.length !== 60) throw new KmsError('invalid_ciphertext');
    const wrapped = Buffer.from(input.wrapped);
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.wrapKey, wrapped.subarray(0, 12));
      decipher.setAAD(canonical(input.context, this.keyId));
      decipher.setAuthTag(wrapped.subarray(44));
      return Uint8Array.from(
        Buffer.concat([decipher.update(wrapped.subarray(12, 44)), decipher.final()]),
      );
    } catch {
      throw new KmsError('invalid_ciphertext');
    }
  }

  public async mac(input: {
    readonly tenantId: string;
    readonly message: Uint8Array;
  }): Promise<Uint8Array> {
    if (!TENANT.test(input.tenantId) || input.message.length > MAX_MESSAGE_BYTES)
      throw new KmsError('invalid_input');
    const tenantKey = createHmac('sha256', this.macKey).update(`tenant:${input.tenantId}`).digest();
    return Uint8Array.from(createHmac('sha256', tenantKey).update(input.message).digest());
  }
}

/** Constant-time equality for tests and callers comparing blind indexes or keys. */
export const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && timingSafeEqual(a, b);
