import { describe, expect, it } from 'vitest';
import { EnvelopePiiCipher, PiiError } from '../cipher.js';
import { KmsError, type KmsPort } from '../kms.js';

/**
 * Contract every `KmsPort` adapter must pass, local or cloud: run it with a factory that returns a
 * fresh, working adapter (for AWS KMS: a staging key with GenerateDataKey, Decrypt and GenerateMac).
 * It checks behavior only; it never needs the key material.
 */
export function describeKmsPortContract(name: string, factory: () => KmsPort | Promise<KmsPort>) {
  const ctx = { tenantId: 'tenant-a', entityType: 'employee', entityId: 'e-1', field: 'phone' };

  describe(`KmsPort contract: ${name}`, () => {
    it('generates a fresh 256-bit data key with a non-empty wrapped form and a key id', async () => {
      const kms = await factory();
      const a = await kms.generateDataKey({ tenantId: 'tenant-a' });
      const b = await kms.generateDataKey({ tenantId: 'tenant-a' });
      expect(a.plaintext).toHaveLength(32);
      expect(a.wrapped.length).toBeGreaterThan(0);
      expect(a.keyId.length).toBeGreaterThan(0);
      expect(Buffer.from(a.plaintext).equals(Buffer.from(b.plaintext))).toBe(false);
      expect(Buffer.from(a.wrapped).equals(Buffer.from(b.wrapped))).toBe(false);
      expect(Buffer.from(a.wrapped).includes(Buffer.from(a.plaintext))).toBe(false);
    });

    it('unwraps to the same key only under the same encryption context', async () => {
      const kms = await factory();
      const context = { tenantId: 'tenant-a', entityId: 'e-1', field: 'phone' };
      const key = await kms.generateDataKey(context);
      const same = await kms.decryptDataKey({
        keyId: key.keyId,
        wrapped: key.wrapped,
        context: { field: 'phone', entityId: 'e-1', tenantId: 'tenant-a' },
      });
      expect(Buffer.from(same).equals(Buffer.from(key.plaintext))).toBe(true);
      for (const other of [
        { ...context, tenantId: 'tenant-b' },
        { ...context, entityId: 'e-2' },
        { ...context, field: 'email' },
        { tenantId: 'tenant-a', entityId: 'e-1' },
        { ...context, extra: 'x' },
      ])
        await expect(
          kms.decryptDataKey({ keyId: key.keyId, wrapped: key.wrapped, context: other }),
        ).rejects.toBeInstanceOf(KmsError);
    });

    it('rejects a tampered or truncated wrapped key and a foreign key id', async () => {
      const kms = await factory();
      const key = await kms.generateDataKey({ tenantId: 'tenant-a' });
      const flipped = Uint8Array.from(key.wrapped);
      flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 0x01;
      const input = { keyId: key.keyId, context: { tenantId: 'tenant-a' } };
      await expect(kms.decryptDataKey({ ...input, wrapped: flipped })).rejects.toBeInstanceOf(
        KmsError,
      );
      await expect(
        kms.decryptDataKey({ ...input, wrapped: key.wrapped.slice(0, 8) }),
      ).rejects.toBeInstanceOf(KmsError);
      await expect(
        kms.decryptDataKey({ ...input, keyId: 'another-key', wrapped: key.wrapped }),
      ).rejects.toBeInstanceOf(KmsError);
    });

    it('computes a deterministic 32-byte MAC that is scoped to the tenant and the message', async () => {
      const kms = await factory();
      const message = Buffer.from('synthetic-value');
      const a1 = await kms.mac({ tenantId: 'tenant-a', message });
      const a2 = await kms.mac({ tenantId: 'tenant-a', message });
      const b = await kms.mac({ tenantId: 'tenant-b', message });
      const other = await kms.mac({
        tenantId: 'tenant-a',
        message: Buffer.from('synthetic-other'),
      });
      expect(a1).toHaveLength(32);
      expect(Buffer.from(a1).equals(Buffer.from(a2))).toBe(true);
      expect(Buffer.from(a1).equals(Buffer.from(b))).toBe(false);
      expect(Buffer.from(a1).equals(Buffer.from(other))).toBe(false);
    });

    it('never leaks material or values through errors', async () => {
      const kms = await factory();
      const key = await kms.generateDataKey({ tenantId: 'tenant-a' });
      const failure = await kms
        .decryptDataKey({
          keyId: key.keyId,
          wrapped: key.wrapped,
          context: { tenantId: 'secret-tenant-marker' },
        })
        .then(
          () => null,
          (error: unknown) => error as Error,
        );
      expect(failure).toBeInstanceOf(KmsError);
      const text = `${failure?.message}${failure?.stack}${JSON.stringify(failure)}`;
      expect(text).not.toContain('secret-tenant-marker');
      expect(text).not.toContain(Buffer.from(key.plaintext).toString('base64'));
      expect(text).not.toContain(Buffer.from(key.plaintext).toString('hex'));
    });

    it('supports the envelope cipher end to end (round trip, context binding, blind index)', async () => {
      const cipher = new EnvelopePiiCipher(await factory());
      const sealed = await cipher.seal(ctx, 'synthetic-secret-value');
      expect(sealed).not.toContain('synthetic-secret-value');
      expect(await cipher.open(ctx, sealed)).toBe('synthetic-secret-value');
      await expect(cipher.open({ ...ctx, entityId: 'e-2' }, sealed)).rejects.toBeInstanceOf(
        PiiError,
      );
      await expect(cipher.open({ ...ctx, tenantId: 'tenant-b' }, sealed)).rejects.toBeInstanceOf(
        PiiError,
      );
      const index = await cipher.blindIndex('tenant-a', 'national_id', 'AAA123');
      expect(index).toMatch(/^[0-9a-f]{64}$/);
      expect(await cipher.blindIndex('tenant-a', 'national_id', 'AAA123')).toBe(index);
      expect(await cipher.blindIndex('tenant-b', 'national_id', 'AAA123')).not.toBe(index);
      expect(await cipher.blindIndex('tenant-a', 'email', 'AAA123')).not.toBe(index);
    });
  });
}
