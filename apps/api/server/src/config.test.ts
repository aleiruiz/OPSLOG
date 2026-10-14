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
    expect(() => readConfig({ ...base, PORT: 'abc' })).toThrow('PORT');
    expect(() => readConfig({ ...base, PORT: '70000' })).toThrow('PORT');
    expect(() => readConfig({ ...base, OPSLOG_AUTH_MODE: 'cognito' })).toThrow('synthetic');
  });
});
