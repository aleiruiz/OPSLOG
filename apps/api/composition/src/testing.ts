import type { ExternalClaims, OidcVerifier } from '../../../../packages/platform/auth/src/index.js';

export {
  DownloadGrants,
  FakeScanner,
  InMemoryObjectStorage,
  InMemoryScanQueue,
  SYNTHETIC_MALWARE_MARKER,
  refFor,
} from '../../../../packages/platform/files/src/index.js';
export { InMemoryAuditStore } from '../../../../packages/platform/audit/src/index.js';
export { InMemoryOutboxStore } from '../../../../packages/platform/outbox/src/index.js';
export { InMemoryIdentityStore } from '../../../../packages/domain/identity/src/index.js';
export { InMemoryFileRecordStore } from '../../../../packages/domain/files/src/index.js';

/**
 * Synthetic OIDC verifier: codes are issued by the test and are single use. It stands in for the
 * real server-side verifier (authorization code + PKCE, signature, audience), which does not exist yet.
 */
export class FakeOidcVerifier implements OidcVerifier {
  private readonly codes = new Map<string, ExternalClaims>();
  public constructor(public readonly issuer = 'https://idp.synthetic.test') {}
  public issueCode(
    subject: string,
    nonce = 'synthetic-nonce',
    overrides: Partial<ExternalClaims> = {},
  ): string {
    const code = `code-${this.codes.size + 1}-${Math.random().toString(36).slice(2)}`;
    this.codes.set(code, { issuer: this.issuer, subject, nonce, ...overrides });
    return code;
  }
  public async verify(code: string): Promise<ExternalClaims> {
    const claims = this.codes.get(code);
    if (!claims) throw new Error('unknown code');
    this.codes.delete(code);
    return claims;
  }
}
