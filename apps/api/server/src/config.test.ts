import { describe, expect, it } from 'vitest';
import { readConfig } from './config.js';

const base = {
  OPSLOG_PUBLIC_ORIGIN: 'https://demo.example.test',
  OPSLOG_BFF_SECRET: 'b'.repeat(32),
  OPSLOG_GRANT_SECRET: 'g'.repeat(32),
};

describe('readConfig', () => {
  it('reads the required variables and applies defaults', () => {
    expect(readConfig(base)).toEqual({
      host: '0.0.0.0',
      port: 8080,
      publicOrigin: 'https://demo.example.test',
      bffSecret: base.OPSLOG_BFF_SECRET,
      grantSecret: base.OPSLOG_GRANT_SECRET,
      authMode: 'synthetic',
      objectStorage: 'memory',
    });
    expect(readConfig({ ...base, PORT: '9000', HOST: '127.0.0.1' })).toMatchObject({
      port: 9000,
      host: '127.0.0.1',
    });
  });

  it('accepts http only on loopback', () => {
    expect(
      readConfig({ ...base, OPSLOG_PUBLIC_ORIGIN: 'http://localhost:8081' }).publicOrigin,
    ).toBe('http://localhost:8081');
    expect(() => readConfig({ ...base, OPSLOG_PUBLIC_ORIGIN: 'http://demo.example.test' })).toThrow(
      'https origin',
    );
  });

  it.each([
    ['not a url', 'must be an origin'],
    ['https://demo.example.test/path', 'without path'],
    ['https://demo.example.test/', 'without path'],
  ])('rejects the origin %s', (origin, message) => {
    expect(() => readConfig({ ...base, OPSLOG_PUBLIC_ORIGIN: origin })).toThrow(message);
  });

  it.each(['OPSLOG_PUBLIC_ORIGIN', 'OPSLOG_BFF_SECRET', 'OPSLOG_GRANT_SECRET'])(
    'requires %s without echoing values',
    (name) => {
      expect(() => readConfig({ ...base, [name]: ' ' })).toThrow(`${name} is required`);
    },
  );

  it('rejects short secrets, bad ports and unsupported auth modes', () => {
    expect(() => readConfig({ ...base, OPSLOG_BFF_SECRET: 'short' })).toThrow('OPSLOG_BFF_SECRET');
    expect(() => readConfig({ ...base, OPSLOG_GRANT_SECRET: 'short' })).toThrow(
      'OPSLOG_GRANT_SECRET',
    );
    expect(() => readConfig({ ...base, OPSLOG_GRANT_SECRET: base.OPSLOG_BFF_SECRET })).toThrow(
      'must differ',
    );
    expect(readConfig({ ...base, OPSLOG_OBJECT_STORAGE: 's3' }).objectStorage).toBe('s3');
    expect(() => readConfig({ ...base, OPSLOG_OBJECT_STORAGE: 'gcs' })).toThrow('memory or s3');
    expect(() => readConfig({ ...base, PORT: 'abc' })).toThrow('PORT');
    expect(() => readConfig({ ...base, PORT: '70000' })).toThrow('PORT');
    expect(() => readConfig({ ...base, OPSLOG_AUTH_MODE: 'saml' })).toThrow('synthetic or cognito');
  });

  describe('cognito mode', () => {
    const cognito = {
      ...base,
      OPSLOG_AUTH_MODE: 'cognito',
      OPSLOG_OIDC_ISSUER: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_pool',
      OPSLOG_OIDC_DOMAIN: 'https://demo.auth.us-east-1.amazoncognito.com',
      OPSLOG_OIDC_CLIENT_ID: 'client-id',
      OPSLOG_OIDC_CLIENT_SECRET: 'client-secret-value',
      OPSLOG_OIDC_REDIRECT_URI: 'https://demo.example.test/auth/callback',
    };

    it('parses the Cognito settings', () => {
      const config = readConfig(cognito);
      expect(config.authMode).toBe('cognito');
      expect(config.oidc).toMatchObject({
        clientId: 'client-id',
        issuer: cognito.OPSLOG_OIDC_ISSUER,
      });
      expect(readConfig(base).oidc).toBeUndefined();
    });

    it.each([
      'OPSLOG_OIDC_ISSUER',
      'OPSLOG_OIDC_DOMAIN',
      'OPSLOG_OIDC_CLIENT_ID',
      'OPSLOG_OIDC_CLIENT_SECRET',
      'OPSLOG_OIDC_REDIRECT_URI',
    ])('requires %s', (name) => {
      expect(() => readConfig({ ...cognito, [name]: '' })).toThrow(`${name} is required`);
    });

    it('rejects insecure or foreign URLs without echoing values', () => {
      expect(() =>
        readConfig({ ...cognito, OPSLOG_OIDC_ISSUER: 'http://idp.example.test' }),
      ).toThrow('OPSLOG_OIDC_ISSUER must be https');
      const bad = () => readConfig({ ...cognito, OPSLOG_OIDC_DOMAIN: 'not a url secret-ish' });
      expect(bad).toThrow('must be URLs');
      expect(bad).not.toThrow('secret-ish');
      expect(() =>
        readConfig({
          ...cognito,
          OPSLOG_OIDC_REDIRECT_URI: 'https://other.example.test/auth/callback',
        }),
      ).toThrow('OPSLOG_OIDC_REDIRECT_URI must be OPSLOG_PUBLIC_ORIGIN + /auth/callback');
      expect(() =>
        readConfig({ ...cognito, OPSLOG_OIDC_REDIRECT_URI: 'https://demo.example.test/callback' }),
      ).toThrow('OPSLOG_OIDC_REDIRECT_URI must be OPSLOG_PUBLIC_ORIGIN + /auth/callback');
    });
  });

  describe('first-company bootstrap', () => {
    it('is off by default and read when both variables are set', () => {
      expect(readConfig(base).bootstrap).toBeUndefined();
      expect(
        readConfig({
          ...base,
          OPSLOG_BOOTSTRAP_COMPANY: ' Demo SA ',
          OPSLOG_BOOTSTRAP_ADMIN_SUB: 'sub-1',
        }).bootstrap,
      ).toEqual({ companyName: 'Demo SA', adminSubject: 'sub-1' });
    });

    it('rejects a half-set pair and oversized values', () => {
      expect(() => readConfig({ ...base, OPSLOG_BOOTSTRAP_COMPANY: 'Demo' })).toThrow('together');
      expect(() => readConfig({ ...base, OPSLOG_BOOTSTRAP_ADMIN_SUB: 'sub-1' })).toThrow(
        'together',
      );
      const ok = { OPSLOG_BOOTSTRAP_COMPANY: 'Demo', OPSLOG_BOOTSTRAP_ADMIN_SUB: 'sub-1' };
      expect(() =>
        readConfig({ ...base, ...ok, OPSLOG_BOOTSTRAP_COMPANY: 'x'.repeat(161) }),
      ).toThrow('OPSLOG_BOOTSTRAP_COMPANY');
      expect(() =>
        readConfig({ ...base, ...ok, OPSLOG_BOOTSTRAP_ADMIN_SUB: 'x'.repeat(201) }),
      ).toThrow('OPSLOG_BOOTSTRAP_ADMIN_SUB');
    });
  });
});
