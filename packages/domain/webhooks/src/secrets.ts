import { generateSecret } from '../../../platform/webhooks/src/index.js';
import type { PiiCipher } from '../../../platform/pii/src/index.js';
import { SECRET_ENTITY } from './catalog.js';
import type { Endpoint } from './types.js';

type Which = 'signing_secret' | 'previous_secret';
const context = (tenantId: string, endpointId: string, field: Which) => ({
  tenantId,
  entityType: SECRET_ENTITY,
  entityId: endpointId,
  field,
});

/**
 * Secrets are stored sealed with the company cipher (they cannot be hashed: signing needs the
 * value) and bound to the endpoint, so a sealed value cannot be moved to another endpoint or company.
 */
export class SecretVault {
  public constructor(private readonly cipher: PiiCipher) {}

  public async create(tenantId: string, endpointId: string) {
    const secret = generateSecret();
    return { secret, sealed: await this.seal(tenantId, endpointId, 'signing_secret', secret) };
  }

  public seal(tenantId: string, endpointId: string, field: Which, secret: string): Promise<string> {
    return this.cipher.seal(context(tenantId, endpointId, field), secret);
  }

  /** The secrets that sign now: the current one first, then the previous while its grace lasts. */
  public async signing(endpoint: Endpoint, now: Date): Promise<readonly string[]> {
    const secrets = [
      await this.cipher.open(
        context(endpoint.tenantId, endpoint.id, 'signing_secret'),
        endpoint.secretSealed,
      ),
    ];
    if (
      endpoint.previousSealed !== null &&
      endpoint.previousExpiresAt !== null &&
      Date.parse(endpoint.previousExpiresAt) > now.getTime()
    )
      secrets.push(
        await this.cipher.open(
          context(endpoint.tenantId, endpoint.id, 'previous_secret'),
          endpoint.previousSealed,
        ),
      );
    return secrets;
  }
}
