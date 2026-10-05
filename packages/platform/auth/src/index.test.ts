import { describe, expect, it } from 'vitest';
import { assertClaims, type ExternalClaims } from './index.js';

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
});
