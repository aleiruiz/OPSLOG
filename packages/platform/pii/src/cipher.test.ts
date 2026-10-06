import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  EnvelopePiiCipher,
  KmsError,
  LocalDevKms,
  PiiError,
  SEALED_PATTERN,
  type KmsPort,
  type PiiContext,
} from './index.js';

const MASTER = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);
const kms = (): LocalDevKms => new LocalDevKms({ masterKey: MASTER, environment: 'test' });
const ctx: PiiContext = {
  tenantId: 'tenant-a',
  entityType: 'employee',
  entityId: 'emp-1',
  field: 'national_id',
};
const SECRET = 'SYNTH-ID-0000-SECRET';

const failing = (overrides: Partial<KmsPort>): KmsPort => ({
  ...kms(),
  ...bind(kms()),
  ...overrides,
});
function bind(real: LocalDevKms): KmsPort {
  return {
    generateDataKey: (c) => real.generateDataKey(c),
    decryptDataKey: (i) => real.decryptDataKey(i),
    mac: (i) => real.mac(i),
  };
}
const cause = async (promise: Promise<unknown>): Promise<Error> =>
  promise.then(
    () => {
      throw new Error('expected a failure');
    },
    (error: unknown) => error as Error,
  );

/** A KMS that ignores the encryption context and the tenant: only the cipher's own AAD and message bind them. */
const lenientKms = (): KmsPort => {
  const key = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
  return {
    generateDataKey: async () => ({
      keyId: 'k1',
      plaintext: Uint8Array.from(key),
      wrapped: Uint8Array.from([1, 2, 3]),
    }),
    decryptDataKey: async () => Uint8Array.from(key),
    mac: async (input) => Uint8Array.from(createHmac('sha256', key).update(input.message).digest()),
  };
};

describe('EnvelopePiiCipher independent of the KMS', () => {
  it('does not open an envelope moved to another tenant, entity type, entity or field (AAD is load-bearing)', async () => {
    const cipher = new EnvelopePiiCipher(lenientKms());
    const sealed = await cipher.seal(ctx, SECRET);
    expect(await cipher.open(ctx, sealed)).toBe(SECRET);
    for (const moved of [
      { ...ctx, tenantId: 'tenant-b' },
      { ...ctx, entityType: 'vehicle' },
      { ...ctx, entityId: 'emp-2' },
      { ...ctx, field: 'phone' },
    ])
      expect((await cause(cipher.open(moved, sealed))) as PiiError).toMatchObject({
        code: 'invalid_sealed',
      });
  });

  it('separates blind indexes by tenant even when the KMS adapter does not', async () => {
    const cipher = new EnvelopePiiCipher(lenientKms());
    const a = await cipher.blindIndex('tenant-a', 'national_id', 'ABC123');
    expect(a).not.toBe(await cipher.blindIndex('tenant-b', 'national_id', 'ABC123'));
    expect(a).toBe(await cipher.blindIndex('tenant-a', 'national_id', 'ABC123'));
  });
});

describe('EnvelopePiiCipher', () => {
  it('round-trips and never embeds the plaintext in the envelope', async () => {
    const cipher = new EnvelopePiiCipher(kms());
    const sealed = await cipher.seal(ctx, SECRET);
    expect(sealed).toMatch(SEALED_PATTERN);
    expect(sealed.startsWith('pii1.')).toBe(true);
    expect(sealed).not.toContain(SECRET);
    expect(Buffer.from(sealed, 'utf8').toString('latin1')).not.toContain(SECRET);
    expect(await cipher.open(ctx, sealed)).toBe(SECRET);
    expect(await cipher.open(ctx, await cipher.seal(ctx, 'Ñandú ✓'))).toBe('Ñandú ✓');
  });

  it('uses a fresh data key and nonce each time (equal values seal differently)', async () => {
    const cipher = new EnvelopePiiCipher(kms());
    expect(await cipher.seal(ctx, SECRET)).not.toBe(await cipher.seal(ctx, SECRET));
  });

  it('is bound to tenant, entity, field and entity type', async () => {
    const cipher = new EnvelopePiiCipher(kms());
    const sealed = await cipher.seal(ctx, SECRET);
    for (const other of [
      { ...ctx, tenantId: 'tenant-b' },
      { ...ctx, entityId: 'emp-2' },
      { ...ctx, field: 'phone' },
      { ...ctx, entityType: 'driver' },
    ])
      expect(await cause(cipher.open(other, sealed))).toBeInstanceOf(PiiError);
  });

  it('detects a ciphertext moved to another row even when the KMS ignores the context', async () => {
    const real = kms();
    const lax: KmsPort = {
      generateDataKey: (c) => real.generateDataKey(c),
      decryptDataKey: async (i) => {
        // a careless adapter: unwraps with the original context whatever the caller says
        const key = await real.generateDataKey({});
        void i;
        return key.plaintext;
      },
      mac: (i) => real.mac(i),
    };
    const sealed = await new EnvelopePiiCipher(real).seal(ctx, SECRET);
    const error = await cause(new EnvelopePiiCipher(lax).open(ctx, sealed));
    expect(error).toMatchObject({ code: 'invalid_sealed' });
  });

  it('rejects tampered, truncated and malformed envelopes with a data-free error', async () => {
    const cipher = new EnvelopePiiCipher(kms());
    const sealed = await cipher.seal(ctx, SECRET);
    const parts = sealed.split('.');
    const body = Buffer.from(parts[4] as string, 'base64url');
    body[0] = (body[0] ?? 0) ^ 0xff;
    const tampered = [...parts.slice(0, 4), body.toString('base64url')].join('.');
    const shortIv = [parts[0], parts[1], parts[2], 'AAAA', parts[4]].join('.');
    const shortBody = [parts[0], parts[1], parts[2], parts[3], 'AAAA'].join('.');
    const noKey = [parts[0], parts[1], '', parts[3], parts[4]].join('.');
    for (const bad of [
      tampered,
      shortIv,
      shortBody,
      noKey,
      'pii1.a',
      'plain text',
      '',
      `${sealed}.x`,
    ]) {
      const error = await cause(cipher.open(ctx, bad));
      expect(error).toBeInstanceOf(PiiError);
      expect(`${error.message}${JSON.stringify(error)}`).not.toContain(SECRET);
    }
    expect(await cause(cipher.open(ctx, 7 as unknown as string))).toMatchObject({
      code: 'invalid_sealed',
    });
  });

  it('validates the context and the plaintext without echoing them', async () => {
    const cipher = new EnvelopePiiCipher(kms());
    for (const bad of [
      { ...ctx, tenantId: '' },
      { ...ctx, field: 'Bad Field' },
      { ...ctx, entityId: 'x'.repeat(200) },
      { ...ctx, entityType: 'a b' },
      null as unknown as PiiContext,
    ])
      expect(await cause(cipher.seal(bad, SECRET))).toMatchObject({ code: 'invalid_input' });
    for (const bad of ['', 'x'.repeat(1025), 3 as unknown as string])
      expect(await cause(cipher.seal(ctx, bad))).toMatchObject({ code: 'invalid_input' });
    expect(await cause(cipher.open({ ...ctx, tenantId: '' }, 'pii1.a.b.c.d'))).toMatchObject({
      code: 'invalid_input',
    });
  });

  it('maps every KMS failure to a fixed error that carries no provider detail', async () => {
    const leak = 'arn:aws:kms:secret-detail';
    const boom = (): never => {
      throw Object.assign(new Error(leak), { code: 'AccessDenied' });
    };
    const sealed = await new EnvelopePiiCipher(kms()).seal(ctx, SECRET);
    const generate = new EnvelopePiiCipher(failing({ generateDataKey: boom }));
    const unwrap = new EnvelopePiiCipher(failing({ decryptDataKey: boom }));
    const mac = new EnvelopePiiCipher(failing({ mac: boom }));
    for (const error of [
      await cause(generate.seal(ctx, SECRET)),
      await cause(unwrap.open(ctx, sealed)),
      await cause(mac.blindIndex('tenant-a', 'email', 'a@b.c')),
    ]) {
      expect(error).toMatchObject({ name: 'PiiError', code: 'kms_failure' });
      expect(`${error.message}${error.stack}${JSON.stringify(error)}`).not.toContain(leak);
      expect(`${error.message}${error.stack}`).not.toContain(SECRET);
    }
  });

  it('refuses malformed answers from a KMS adapter', async () => {
    const real = kms();
    const shortKey = new EnvelopePiiCipher(
      failing({
        generateDataKey: async () => ({
          keyId: 'k',
          plaintext: new Uint8Array(16),
          wrapped: new Uint8Array(4),
        }),
      }),
    );
    expect(await cause(shortKey.seal(ctx, SECRET))).toMatchObject({ code: 'kms_failure' });
    const badId = new EnvelopePiiCipher(
      failing({
        generateDataKey: async () => ({
          keyId: 'bad id!',
          plaintext: new Uint8Array(32),
          wrapped: new Uint8Array(4),
        }),
      }),
    );
    expect(await cause(badId.seal(ctx, SECRET))).toMatchObject({ code: 'kms_failure' });
    const sealed = await new EnvelopePiiCipher(real).seal(ctx, SECRET);
    const wrongSize = new EnvelopePiiCipher(
      failing({ decryptDataKey: async () => new Uint8Array(5) }),
    );
    expect(await cause(wrongSize.open(ctx, sealed))).toMatchObject({ code: 'kms_failure' });
    const badMac = new EnvelopePiiCipher(failing({ mac: async () => new Uint8Array(5) }));
    expect(await cause(badMac.blindIndex('tenant-a', 'email', 'x'))).toMatchObject({
      code: 'kms_failure',
    });
  });

  it('wipes the plaintext data key after use', async () => {
    const real = kms();
    let seen: Uint8Array | null = null;
    const spy = new EnvelopePiiCipher({
      generateDataKey: async (c) => {
        const key = await real.generateDataKey(c);
        seen = key.plaintext;
        return key;
      },
      decryptDataKey: (i) => real.decryptDataKey(i),
      mac: (i) => real.mac(i),
    });
    await spy.seal(ctx, SECRET);
    expect((seen as unknown as Uint8Array).every((byte) => byte === 0)).toBe(true);
  });

  it('computes tenant- and field-scoped blind indexes and validates their input', async () => {
    const cipher = new EnvelopePiiCipher(kms());
    const index = await cipher.blindIndex('tenant-a', 'national_id', 'ABC123');
    expect(index).toMatch(/^[0-9a-f]{64}$/);
    expect(index).toBe(await cipher.blindIndex('tenant-a', 'national_id', 'ABC123'));
    expect(index).not.toBe(await cipher.blindIndex('tenant-b', 'national_id', 'ABC123'));
    expect(index).not.toBe(await cipher.blindIndex('tenant-a', 'license_number', 'ABC123'));
    expect(index).not.toBe(await cipher.blindIndex('tenant-a', 'national_id', 'ABC124'));
    expect(index).not.toContain('abc123');
    for (const args of [
      ['', 'f', 'v'],
      ['t', 'Bad', 'v'],
      ['t', 'f', ''],
      ['t', 'f', 'x'.repeat(2000)],
      ['t', 'f', 4],
    ] as const)
      expect(await cause(cipher.blindIndex(args[0], args[1], args[2] as string))).toMatchObject({
        code: 'invalid_input',
      });
  });

  it('exposes typed KMS errors with fixed messages', () => {
    const error = new KmsError('denied');
    expect(error.message).toBe('KMS operation failed: denied');
  });
});
