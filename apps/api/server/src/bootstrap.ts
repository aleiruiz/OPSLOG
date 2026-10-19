import {
  verifyExternalPrincipal,
  type ExternalClaims,
  type OidcVerifier,
} from '../../../../packages/platform/auth/src/index.js';
import { PersistentTenantStore, type Platform } from '../../composition/src/index.js';

const NONCE = 'bootstrap';

export type BootstrapOutcome =
  | 'bootstrap_created'
  | 'bootstrap_skipped_admin_exists'
  | 'bootstrap_skipped_company_exists';

/** Vouches for exactly one operator-configured subject; it is local to start-up and never reachable over HTTP. */
class ConfiguredSubjectVerifier implements OidcVerifier {
  public constructor(private readonly subject: string) {}
  public async verify(_code: string, issuer: string, nonce: string): Promise<ExternalClaims> {
    return { issuer, subject: this.subject, nonce };
  }
}

/**
 * Creates the first company and its administrator, because Cognito is invite-only and a fresh stack
 * has nobody who could invite. Idempotent: when the subject already signs in (an active membership),
 * nothing is created; when a persistent deployment already hosts its company it is skipped too. Returns the event code to log: no name, subject or other personal data.
 */
export async function bootstrapFirstCompany(
  platform: Platform,
  issuer: string,
  input: { readonly companyName: string; readonly adminSubject: string },
): Promise<BootstrapOutcome> {
  const principal = await verifyExternalPrincipal(
    new ConfiguredSubjectVerifier(input.adminSubject),
    'bootstrap',
    issuer,
    NONCE,
  );
  const existing = await platform.signIn(principal);
  if (existing.ok && existing.value) {
    await platform.signOut(existing.value.token);
    return 'bootstrap_skipped_admin_exists';
  }
  // A persistent deployment hosts exactly one company: if it exists but the configured subject can no
  // longer sign in (membership revoked, subject changed), failing here would crash-loop the container.
  if (
    platform.tenants instanceof PersistentTenantStore &&
    platform.tenants
      .all()
      .some((tenant) => tenant.status === 'active' || tenant.status === 'suspended')
  )
    return 'bootstrap_skipped_company_exists';
  const created = await platform.bootstrapTenant({
    name: input.companyName,
    adminPrincipal: principal,
  });
  if (!created.ok) throw new Error('bootstrap of the first company failed');
  return 'bootstrap_created';
}
