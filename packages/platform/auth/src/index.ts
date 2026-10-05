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
  verify(code: string, expectedIssuer: string, expectedNonce: string): Promise<ExternalClaims>;
}
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
