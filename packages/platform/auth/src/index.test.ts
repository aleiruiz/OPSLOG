import { describe, expect, it } from 'vitest';
import {
  AUTH_COOKIE,
  assertClaims,
  authCookie,
  isVerifiedExternalPrincipal,
  type ExternalClaims,
  verifyExternalPrincipal,
} from './index.js';

const valid: ExternalClaims = {
  issuer: 'https://issuer.example',
  subject: 'subject-1',
  nonce: 'nonce-1',
};

describe('OIDC callback claim validation', () => {
  it('accepts claims only for the expected issuer and nonce', () => {
    expect(assertClaims(valid, 'https://issuer.example', 'nonce-1')).toEqual(valid);
  });

  it('rejects a mismatched issuer or nonce with a generic error', () => {
    expect(() => assertClaims(valid, 'https://other.example', 'nonce-1')).toThrow(
      'identity verification failed',
    );
    expect(() => assertClaims(valid, 'https://issuer.example', 'other-nonce')).toThrow(
      'identity verification failed',
    );
  });

  it('rejects missing expected values and absent claims', () => {
    expect(() => assertClaims(valid, '', 'nonce-1')).toThrow('identity verification failed');
    expect(() => assertClaims(valid, 'https://issuer.example', '')).toThrow(
      'identity verification failed',
    );
    expect(() =>
      assertClaims(
        { issuer: 'https://issuer.example', subject: 'subject-1' },
        'https://issuer.example',
        'nonce-1',
      ),
    ).toThrow('identity verification failed');
  });

  it('creates a verified principal only after the server verifier and claim checks pass', async () => {
    const principal = await verifyExternalPrincipal(
      {
        verify: async (_code, issuer, nonce) => ({ issuer, subject: 'subject-1', nonce }),
      },
      'synthetic-code',
      'https://issuer.example',
      'expected-nonce',
    );
    expect(isVerifiedExternalPrincipal(principal)).toBe(true);
    expect(principal).toMatchObject({ provider: 'https://issuer.example', subject: 'subject-1' });
    expect(
      isVerifiedExternalPrincipal({ provider: 'https://issuer.example', subject: 'subject-1' }),
    ).toBe(false);
  });

  it('does not mint a principal when server-side verification or expected claims fail', async () => {
    const verifier = {
      verify: async (_code: string, issuer: string, nonce: string) => ({
        issuer,
        subject: 'subject-1',
        nonce: `${nonce}-wrong`,
      }),
    };
    await expect(
      verifyExternalPrincipal(
        verifier,
        'synthetic-code',
        'https://issuer.example',
        'expected-nonce',
      ),
    ).rejects.toThrow('identity verification failed');
    await expect(
      verifyExternalPrincipal(verifier, '', 'https://issuer.example', 'expected-nonce'),
    ).rejects.toThrow('identity verification failed');
    await expect(
      verifyExternalPrincipal(
        {
          verify: async () => {
            throw new Error('sensitive provider response');
          },
        },
        'synthetic-code',
        'https://issuer.example',
        'expected-nonce',
      ),
    ).rejects.toThrow('identity verification failed');
  });
});

describe('session cookie attributes', () => {
  it('defaults to a secure, http-only, lax cookie scoped to the API path', () => {
    expect(authCookie()).toEqual({
      name: AUTH_COOKIE,
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/api',
    });
    expect(AUTH_COOKIE).toBe('opslog_session');
  });

  it('allows disabling secure for local development while keeping http-only', () => {
    expect(authCookie(false)).toMatchObject({ secure: false, httpOnly: true, sameSite: 'lax' });
  });
});
