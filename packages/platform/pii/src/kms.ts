/** Key/value pairs bound to a wrapped data key (the KMS "encryption context"). */
export type EncryptionContext = Readonly<Record<string, string>>;

export interface DataKey {
  /** Identifies the KMS key that wrapped `wrapped` (opaque to callers). */
  readonly keyId: string;
  /** 32 random bytes. Callers must wipe it after use. */
  readonly plaintext: Uint8Array;
  readonly wrapped: Uint8Array;
}

export type KmsErrorCode = 'unavailable' | 'denied' | 'invalid_ciphertext' | 'invalid_input';

/** Fixed-message failure of a KMS adapter. Adapters must not copy provider messages into it. */
export class KmsError extends Error {
  public constructor(public readonly code: KmsErrorCode) {
    super(`KMS operation failed: ${code}`);
    this.name = 'KmsError';
  }
}

export interface KmsPort {
  /** A fresh 256-bit data key, returned in the clear and wrapped under the master key and `context`. */
  generateDataKey(context: EncryptionContext): Promise<DataKey>;
  /** Unwraps a data key. It must fail unless `context` equals the one used at generation. */
  decryptDataKey(input: {
    readonly keyId: string;
    readonly wrapped: Uint8Array;
    readonly context: EncryptionContext;
  }): Promise<Uint8Array>;
  /**
   * HMAC-SHA-256 of `message` under a key that is specific to `tenantId` (32 bytes). The same
   * tenant and message always give the same output; another tenant gives an unrelated one.
   */
  mac(input: { readonly tenantId: string; readonly message: Uint8Array }): Promise<Uint8Array>;
}
