import { describe, expect, it } from 'vitest';
import { KmsError, LocalDevKms, sameBytes } from './index.js';
import { describeKmsPortContract } from './testing/kms-contract.js';

const MASTER = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const make = (): LocalDevKms => new LocalDevKms({ masterKey: MASTER, environment: 'test' });

describeKmsPortContract('LocalDevKms', make);

describe('LocalDevKms', () => {
  it('refuses a production configuration, however it is announced', () => {
    for (const environment of ['production', 'PRODUCTION', ' prod ', 'Prod'])
      expect(() => new LocalDevKms({ masterKey: MASTER, environment })).toThrow(/production/);
    expect(() => LocalDevKms.assertNotProduction('test', { NODE_ENV: 'production' })).toThrow(
      /production/,
    );
    expect(() => LocalDevKms.assertNotProduction('test', { OPSLOG_ENV: 'production' })).toThrow(
      /production/,
    );
    expect(() => LocalDevKms.assertNotProduction('test', { NODE_ENV: 'test' })).not.toThrow();
    expect(() => LocalDevKms.ephemeral('production')).toThrow(/production/);
  });

  it('is refused while the process itself runs in production mode', () => {
    const previous = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    try {
      expect(() => make()).toThrow(/production/);
    } finally {
      if (previous === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = previous;
    }
  });

  it('rejects weak or malformed configuration without echoing it', () => {
    expect(() => new LocalDevKms({ masterKey: new Uint8Array(31), environment: 'test' })).toThrow(
      /at least 32 bytes/,
    );
    expect(
      () => new LocalDevKms({ masterKey: 'x' as unknown as Uint8Array, environment: 'test' }),
    ).toThrow(/at least 32 bytes/);
    expect(
      () => new LocalDevKms({ masterKey: MASTER, environment: 'test', keyId: 'bad key!' }),
    ).toThrow(/key id/);
  });

  it('builds from a base64 master key and from an ephemeral one', async () => {
    const fromConfig = LocalDevKms.fromBase64(Buffer.from(MASTER).toString('base64'), 'test');
    const key = await make().generateDataKey({ tenantId: 't' });
    // same master key: it can unwrap what the other instance wrapped
    expect(
      sameBytes(
        await fromConfig.decryptDataKey({
          keyId: key.keyId,
          wrapped: key.wrapped,
          context: { tenantId: 't' },
        }),
        key.plaintext,
      ),
    ).toBe(true);
    // a random master key cannot
    await expect(
      LocalDevKms.ephemeral('test').decryptDataKey({
        keyId: key.keyId,
        wrapped: key.wrapped,
        context: { tenantId: 't' },
      }),
    ).rejects.toBeInstanceOf(KmsError);
  });

  it('is deterministic when the random source is injected', async () => {
    let counter = 0;
    const random = (size: number) => Uint8Array.from({ length: size }, () => (counter += 1) % 251);
    const a = new LocalDevKms({ masterKey: MASTER, environment: 'test', random });
    counter = 0;
    const b = new LocalDevKms({ masterKey: MASTER, environment: 'test', random });
    const first = await a.generateDataKey({ tenantId: 't' });
    counter = 0;
    const second = await b.generateDataKey({ tenantId: 't' });
    expect(Buffer.from(first.wrapped).equals(Buffer.from(second.wrapped))).toBe(true);
  });

  it('fails closed when the random source returns the wrong size', async () => {
    const kms = new LocalDevKms({
      masterKey: MASTER,
      environment: 'test',
      random: () => new Uint8Array(3),
    });
    await expect(kms.generateDataKey({ tenantId: 't' })).rejects.toMatchObject({
      code: 'unavailable',
    });
  });

  it('validates MAC inputs', async () => {
    const kms = make();
    await expect(
      kms.mac({ tenantId: 'bad tenant', message: new Uint8Array(1) }),
    ).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(kms.mac({ tenantId: 't', message: new Uint8Array(5000) })).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('compares bytes in constant time and by length', () => {
    expect(sameBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(sameBytes(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(sameBytes(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
  });
});
