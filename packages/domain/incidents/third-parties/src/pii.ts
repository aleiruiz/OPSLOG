import { SEALED_PATTERN, type PiiCipher } from '../../../../platform/pii/src/index.js';
import type { ProtectedField } from './catalog.js';

/** Column-style names of the fields in the encryption context (lowercase, underscores). */
const CONTEXT_FIELD: Readonly<Record<ProtectedField, string>> = {
  name: 'name',
  contact: 'contact',
  plates: 'plates',
  policyNumber: 'policy_number',
};

/** True for a `pii1.` envelope: the only shape a protected column may hold. */
export const isSealed = (value: unknown): value is string =>
  typeof value === 'string' && SEALED_PATTERN.test(value);

/**
 * Seals and opens the protected identity of a third party (SPECS D23). The encryption context binds
 * the tenant, the case, the third party and the field, so a ciphertext cannot be moved to another
 * row. Failures carry no value, key or provider text.
 */
export class IdentityVault {
  public constructor(private readonly cipher: PiiCipher) {}

  private context(tenantId: string, incidentId: string, partyId: string, field: ProtectedField) {
    return {
      tenantId,
      entityType: 'incident_third_party',
      entityId: `${incidentId}:${partyId}`,
      field: CONTEXT_FIELD[field],
    };
  }

  public async seal(
    tenantId: string,
    incidentId: string,
    partyId: string,
    field: ProtectedField,
    plaintext: string,
  ): Promise<string> {
    try {
      return await this.cipher.seal(this.context(tenantId, incidentId, partyId, field), plaintext);
    } catch {
      throw new Error('Third party identity could not be sealed');
    }
  }

  public async open(
    tenantId: string,
    incidentId: string,
    partyId: string,
    field: ProtectedField,
    sealed: string,
  ): Promise<string> {
    try {
      return await this.cipher.open(this.context(tenantId, incidentId, partyId, field), sealed);
    } catch {
      throw new Error('Third party identity could not be opened');
    }
  }

  /**
   * A stable stand-in for the protected values of a request, used in the idempotency hash: a keyed
   * blind index, so the stored hash cannot be matched against a list of names or plates.
   */
  public async fingerprint(
    tenantId: string,
    values: Readonly<Partial<Record<ProtectedField, string | null>>>,
  ): Promise<Readonly<Record<string, string | null>>> {
    const out: Record<string, string | null> = {};
    for (const [field, value] of Object.entries(values) as [ProtectedField, string | null][])
      try {
        out[field] =
          value === null
            ? null
            : await this.cipher.blindIndex(tenantId, `third_party_${CONTEXT_FIELD[field]}`, value);
      } catch {
        throw new Error('Third party identity could not be fingerprinted');
      }
    return out;
  }
}
