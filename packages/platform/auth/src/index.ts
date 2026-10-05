export const AUTH_COOKIE = 'opslog_session';
export const authCookie = (secure = true) => ({
  name: AUTH_COOKIE,
  httpOnly: true,
  secure,
  sameSite: 'lax' as const,
  path: '/api',
});
export interface ExternalClaims {
  readonly issuer: string;
  readonly subject: string;
  readonly nonce?: string;
  readonly emailVerified?: boolean;
}
export interface OidcVerifier {
  /** Server-side adapter must validate the authorization code, token signature, audience and time claims before returning claims. */
  verify(code: string, expectedIssuer: string, expectedNonce: string): Promise<ExternalClaims>;
}

const verifiedPrincipalBrand: unique symbol = Symbol('verified-external-principal');
export interface VerifiedExternalPrincipal {
  readonly [verifiedPrincipalBrand]: true;
  readonly provider: string;
  readonly subject: string;
}

export const isVerifiedExternalPrincipal = (value: unknown): value is VerifiedExternalPrincipal =>
  typeof value === 'object' &&
  value !== null &&
  (value as Partial<VerifiedExternalPrincipal>)[verifiedPrincipalBrand] === true;

export const assertClaims = (
  claims: ExternalClaims,
  expectedIssuer: string,
  expectedNonce: string,
): ExternalClaims => {
  if (
    !expectedIssuer.trim() ||
    !expectedNonce.trim() ||
    !claims.issuer.trim() ||
    claims.issuer !== expectedIssuer ||
    !claims.subject.trim() ||
    claims.subject.length > 200 ||
    !claims.nonce ||
    claims.nonce !== expectedNonce
  )
    throw new Error('identity verification failed');
  return Object.freeze({ ...claims });
};

export const verifyExternalPrincipal = async (
  verifier: OidcVerifier,
  code: string,
  expectedIssuer: string,
  expectedNonce: string,
): Promise<VerifiedExternalPrincipal> => {
  if (!code.trim()) throw new Error('identity verification failed');
  let verifiedClaims: ExternalClaims;
  try {
    verifiedClaims = await verifier.verify(code, expectedIssuer, expectedNonce);
  } catch {
    throw new Error('identity verification failed');
  }
  const claims = assertClaims(verifiedClaims, expectedIssuer, expectedNonce);
  return Object.freeze({
    [verifiedPrincipalBrand]: true as const,
    provider: claims.issuer,
    subject: claims.subject,
  });
};
