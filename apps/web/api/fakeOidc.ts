import type { OidcCredentials, OidcPort, Result } from '../app/types';

/** Authorization codes of the fake provider carry the synthetic account they stand for. */
export const FAKE_OIDC_CODE_PREFIX = 'fake-code:';

const MAX_HINT = 128;

export const fakeOidcCode = (subject: string): string => `${FAKE_OIDC_CODE_PREFIX}${subject}`;

/** The account a fake authorization code stands for, or null when the code is not a fake one. */
export function fakeOidcSubject(code: string): string | null {
  return code.startsWith(FAKE_OIDC_CODE_PREFIX) && code.length > FAKE_OIDC_CODE_PREFIX.length
    ? code.slice(FAKE_OIDC_CODE_PREFIX.length)
    : null;
}

let counter = 0;
function newNonce(): string {
  counter += 1;
  const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `fake-nonce-${counter}-${random}`;
}

/**
 * Local stand-in for the identity provider: no network, no redirect. The person types which
 * synthetic account to enter as and receives a code for it plus a fresh nonce. It exists for local
 * work and UI tests only; a production build injects a redirecting provider instead.
 */
export function createFakeOidc(): OidcPort {
  return {
    hintLabel: 'Cuenta de prueba',
    authorize: async (hint): Promise<Result<OidcCredentials>> => {
      const subject = hint.trim();
      if (!subject || subject.length > MAX_HINT)
        return {
          ok: false,
          error: {
            code: 'bad_request',
            status: 400,
            message: 'Indica la cuenta de prueba.',
            correlationId: 'fake-oidc',
          },
        };
      return { ok: true, value: { code: fakeOidcCode(subject), nonce: newNonce() } };
    },
  };
}
