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
  verify(code: string, expectedNonce: string): Promise<ExternalClaims>;
}
export const assertClaims = (claims: ExternalClaims): ExternalClaims => {
  if (!claims.issuer.trim() || !claims.subject.trim() || claims.subject.length > 200)
    throw new Error('invalid identity claims');
  return Object.freeze({ ...claims });
};
