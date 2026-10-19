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
      persistence: 'memory',
      readOnly: false,
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

  it('reads the MySQL persistence variables only when asked for', () => {
    const mysql = {
      ...base,
      OPSLOG_PERSISTENCE: 'mysql',
      OPSLOG_MYSQL_SECRET: 's'.repeat(32),
      OPSLOG_PII_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
    };
    expect(readConfig(mysql)).toMatchObject({
      persistence: 'mysql',
      mysql: {
        host: 'mysql',
        port: 3306,
        database: 'opslog_t_main',
        secret: mysql.OPSLOG_MYSQL_SECRET,
        piiMasterKey: mysql.OPSLOG_PII_MASTER_KEY,
      },
    });
    expect(
      readConfig({
        ...mysql,
        OPSLOG_MYSQL_HOST: 'db.internal',
        OPSLOG_MYSQL_PORT: '3307',
        OPSLOG_MYSQL_DATABASE: 'opslog_t_demo',
      }).mysql,
    ).toMatchObject({ host: 'db.internal', port: 3307, database: 'opslog_t_demo' });
    expect(readConfig({ ...base, OPSLOG_PERSISTENCE: 'memory' })).not.toHaveProperty('mysql');
    expect(() => readConfig({ ...base, OPSLOG_PERSISTENCE: 'redis' })).toThrow('memory or mysql');
  });

  it.each([
    [{ OPSLOG_MYSQL_SECRET: '' }, 'OPSLOG_MYSQL_SECRET is required'],
    [{ OPSLOG_MYSQL_SECRET: 'short' }, 'OPSLOG_MYSQL_SECRET needs at least 32'],
    [{ OPSLOG_PII_MASTER_KEY: '' }, 'OPSLOG_PII_MASTER_KEY is required'],
    [{ OPSLOG_PII_MASTER_KEY: 'c2hvcnQ=' }, 'at least 32 bytes'],
    [{ OPSLOG_MYSQL_PORT: 'x' }, 'OPSLOG_MYSQL_PORT'],
    [{ OPSLOG_MYSQL_PORT: '0' }, 'OPSLOG_MYSQL_PORT'],
    [{ OPSLOG_MYSQL_DATABASE: 'opslog' }, 'opslog_t_<name>'],
    [{ OPSLOG_MYSQL_DATABASE: 'opslog_t_x; DROP' }, 'opslog_t_<name>'],
  ])('rejects invalid MySQL settings %j without echoing values', (override, message) => {
    const env = {
      ...base,
      OPSLOG_PERSISTENCE: 'mysql',
      OPSLOG_MYSQL_SECRET: 's'.repeat(32),
      OPSLOG_PII_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
      ...override,
    };
    expect(() => readConfig(env)).toThrow(message);
  });

  describe('SMTP', () => {
    const smtp = {
      OPSLOG_SMTP_HOST: 'smtp.example.test',
      OPSLOG_SMTP_PORT: '587',
      OPSLOG_SMTP_USER: 'mailer',
      OPSLOG_SMTP_PASSWORD: 'not-a-real-secret',
      OPSLOG_SMTP_FROM: 'opslog@example.test',
    };

    it('keeps the sink when none is set and enables SMTP when all five are', () => {
      expect(readConfig(base).smtp).toBeUndefined();
      expect(readConfig({ ...base, ...smtp }).smtp).toMatchObject({
        host: 'smtp.example.test',
        port: 587,
      });
    });

    it('fails at start naming the variable, never its value', () => {
      const partial: Record<string, string> = { ...smtp };
      delete partial.OPSLOG_SMTP_USER;
      expect(() => readConfig({ ...base, ...partial })).toThrow('OPSLOG_SMTP_USER');
      let message = '';
      try {
        readConfig({ ...base, ...smtp, OPSLOG_SMTP_PORT: 'banana' });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain('OPSLOG_SMTP_PORT');
      expect(message).not.toContain('banana');
      expect(message).not.toContain(smtp.OPSLOG_SMTP_PASSWORD);
    });
  });
});

describe('OPSLOG_READ_ONLY', () => {
  const mysql = {
    ...base,
    OPSLOG_PERSISTENCE: 'mysql',
    OPSLOG_MYSQL_SECRET: 's'.repeat(40),
    OPSLOG_PII_MASTER_KEY: Buffer.alloc(32, 1).toString('base64'),
  };

  it('is off by default and turns on with true or 1 over MySQL', () => {
    expect(readConfig(mysql).readOnly).toBe(false);
    expect(readConfig({ ...mysql, OPSLOG_READ_ONLY: 'TRUE' }).readOnly).toBe(true);
    expect(readConfig({ ...mysql, OPSLOG_READ_ONLY: '1' }).readOnly).toBe(true);
    expect(readConfig({ ...mysql, OPSLOG_READ_ONLY: '0' }).readOnly).toBe(false);
  });

  it('rejects other values and the memory persistence', () => {
    expect(() => readConfig({ ...mysql, OPSLOG_READ_ONLY: 'maybe' })).toThrow(
      'OPSLOG_READ_ONLY must be true or false',
    );
    expect(() => readConfig({ ...base, OPSLOG_READ_ONLY: 'true' })).toThrow(
      'OPSLOG_READ_ONLY needs OPSLOG_PERSISTENCE=mysql',
    );
  });
});
