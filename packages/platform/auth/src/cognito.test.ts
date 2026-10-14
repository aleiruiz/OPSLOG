import { createSign, generateKeyPairSync, type JsonWebKey } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { cognitoConfigFromEnv, createCognitoVerifier, type CognitoOidcConfig } from './cognito.js';

const ISSUER = 'https://cognito-idp.test-region.amazonaws.com/pool-1';
const config: CognitoOidcConfig = {
  issuer: ISSUER,
  domain: 'https://login.example.test',
  clientId: 'client-1',
  clientSecret: 'secret-1',
  redirectUri: 'https://app.example.test/auth/callback',
};
const VERIFIER = 'v'.repeat(64);
const NOW = 1_800_000_000_000;

const makeKey = (kid: string) => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid } as JsonWebKey };
};
const key = makeKey('k1');
const otherKey = makeKey('k2');

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function sign(
  claims: Record<string, unknown>,
  signer = key,
  header: Record<string, unknown> = { alg: 'RS256', kid: signer.kid },
): string {
  const data = `${b64(header)}.${b64(claims)}`;
  const signature = createSign('RSA-SHA256').update(data).sign(signer.privateKey);
  return `${data}.${signature.toString('base64url')}`;
}
const goodClaims = {
  iss: ISSUER,
  aud: 'client-1',
  sub: 'sub-1',
  token_use: 'id',
  exp: NOW / 1000 + 86_400,
  iat: NOW / 1000 - 5,
  nonce: 'nonce-1',
  email_verified: true,
};

interface Setup {
  idToken?: string;
  tokenStatus?: number;
  tokenBody?: unknown;
  jwks?: unknown;
  jwksStatus?: number;
}
function build(setup: Setup = {}, now = () => NOW) {
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    if (target.endsWith('/.well-known/jwks.json')) {
      const status = setup.jwksStatus ?? 200;
      return new Response(JSON.stringify(setup.jwks ?? { keys: [key.jwk] }), { status });
    }
    expect(target).toBe('https://login.example.test/oauth2/token');
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(headers['authorization']).toBe(
      `Basic ${Buffer.from('client-1:secret-1').toString('base64')}`,
    );
    const params = new URLSearchParams(String(init?.body));
    expect(Object.fromEntries(params)).toEqual({
      grant_type: 'authorization_code',
      client_id: 'client-1',
      code: 'code-1',
      redirect_uri: config.redirectUri,
      code_verifier: VERIFIER,
    });
    return new Response(
      JSON.stringify(setup.tokenBody ?? { id_token: setup.idToken ?? sign(goodClaims) }),
      { status: setup.tokenStatus ?? 200 },
    );
  });
  const verifier = createCognitoVerifier(config, {
    fetch: fetchMock as unknown as typeof fetch,
    now,
  });
  return { verifier, fetchMock };
}
const run = (verifier: ReturnType<typeof build>['verifier'], nonce = 'nonce-1', v = VERIFIER) =>
  verifier.verify('code-1', ISSUER, nonce, v);

describe('Cognito OIDC verifier', () => {
  it('redeems the code with PKCE and the client secret and returns verified claims', async () => {
    const { verifier } = build();
    await expect(run(verifier)).resolves.toEqual({
      issuer: ISSUER,
      subject: 'sub-1',
      nonce: 'nonce-1',
      emailVerified: true,
    });
  });

  it('omits emailVerified when the token does not say', async () => {
    const claims = { ...goodClaims, email_verified: undefined };
    const { verifier } = build({ idToken: sign(claims) });
    expect(await run(verifier)).not.toHaveProperty('emailVerified');
  });

  it('caches the JWKS and refreshes once for an unknown key id, at most once a minute', async () => {
    let now = NOW;
    const { verifier, fetchMock } = build({ jwks: { keys: [key.jwk] } }, () => now);
    await run(verifier);
    await run(verifier);
    const jwksCalls = () =>
      fetchMock.mock.calls.filter(([u]) => String(u).endsWith('jwks.json')).length;
    expect(jwksCalls()).toBe(1);
    // A token from an unknown key right away: no refresh (rate limited), rejected.
    const rotated = build(
      { idToken: sign(goodClaims, otherKey), jwks: { keys: [key.jwk] } },
      () => now,
    );
    await run(rotated.verifier).catch(() => undefined);
    now += 61_000;
    await expect(run(rotated.verifier)).rejects.toThrow('unknown signing key');
    expect(
      rotated.fetchMock.mock.calls.filter(([u]) => String(u).endsWith('jwks.json')).length,
    ).toBe(2);
    // After the TTL the set is reloaded even for a known key.
    now += 2 * 60 * 60 * 1000;
    await run(verifier);
    expect(jwksCalls()).toBe(2);
  });

  it('picks up a rotated key after a refresh', async () => {
    const jwks = { keys: [key.jwk] };
    let now = NOW;
    const { verifier } = build({ idToken: sign(goodClaims, otherKey), jwks }, () => now);
    await expect(run(verifier)).rejects.toThrow();
    jwks.keys = [key.jwk, otherKey.jwk];
    now += 61_000;
    await expect(run(verifier)).resolves.toMatchObject({ subject: 'sub-1' });
  });

  it('rejects every way the code or token can be wrong', async () => {
    const bad: [string, Setup, string?, string?][] = [
      ['code rejected', { tokenStatus: 400 }],
      ['no id token', { tokenBody: { access_token: 'x' } }],
      ['jwks down', { jwksStatus: 500 }],
      ['jwks malformed', { jwks: { nope: true } }],
      ['wrong nonce', { idToken: sign({ ...goodClaims, nonce: 'other' }) }],
      ['no nonce', { idToken: sign({ ...goodClaims, nonce: undefined }) }],
      ['wrong issuer', { idToken: sign({ ...goodClaims, iss: 'https://evil.test' }) }],
      ['wrong audience', { idToken: sign({ ...goodClaims, aud: 'other-client' }) }],
      ['access token', { idToken: sign({ ...goodClaims, token_use: 'access' }) }],
      ['no subject', { idToken: sign({ ...goodClaims, sub: undefined }) }],
      ['expired', { idToken: sign({ ...goodClaims, exp: NOW / 1000 - 120 }) }],
      ['no exp', { idToken: sign({ ...goodClaims, exp: undefined }) }],
      ['issued in the future', { idToken: sign({ ...goodClaims, iat: NOW / 1000 + 600 }) }],
      ['bad signature', { idToken: sign(goodClaims, { ...key, privateKey: otherKey.privateKey }) }],
      ['alg none', { idToken: sign(goodClaims, key, { alg: 'none', kid: 'k1' }) }],
      ['alg HS256', { idToken: sign(goodClaims, key, { alg: 'HS256', kid: 'k1' }) }],
      ['no kid', { idToken: sign(goodClaims, key, { alg: 'RS256' }) }],
      ['not a jwt', { idToken: 'abc' }],
      ['garbage parts', { idToken: '!!.!!.!!' }],
      ['array payload', { idToken: `${b64({ alg: 'RS256', kid: 'k1' })}.${b64([1])}.sig` }],
      ['non-RSA key', { jwks: { keys: [{ kty: 'EC', kid: 'k1' }] } }],
    ];
    for (const [name, setup] of bad) {
      const { verifier } = build(setup);
      await expect(run(verifier), name).rejects.toThrow();
    }
  });

  it('refuses a missing PKCE verifier or another issuer without calling Cognito', async () => {
    const { verifier, fetchMock } = build();
    await expect(verifier.verify('code-1', ISSUER, 'nonce-1')).rejects.toThrow();
    await expect(
      verifier.verify('code-1', 'https://other.test', 'nonce-1', VERIFIER),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses the real clock and fetch by default', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 400 })) as typeof fetch;
    try {
      await expect(
        createCognitoVerifier(config).verify('c', ISSUER, 'n', VERIFIER),
      ).rejects.toThrow();
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('Cognito settings from the environment', () => {
  const env = {
    OPSLOG_OIDC_ISSUER: `${ISSUER}/`,
    OPSLOG_OIDC_DOMAIN: 'https://login.example.test/',
    OPSLOG_OIDC_CLIENT_ID: 'client-1',
    OPSLOG_OIDC_CLIENT_SECRET: 'secret-1',
    OPSLOG_OIDC_REDIRECT_URI: 'https://app.example.test/auth/callback',
  };

  it('reads and normalizes the settings', () => {
    expect(cognitoConfigFromEnv(env)).toEqual(config);
  });

  it('requires every setting and https (localhost excepted)', () => {
    for (const name of Object.keys(env))
      expect(() => cognitoConfigFromEnv({ ...env, [name]: ' ' })).toThrow(name);
    expect(() =>
      cognitoConfigFromEnv({ ...env, OPSLOG_OIDC_DOMAIN: 'http://login.example.test' }),
    ).toThrow('https');
    expect(
      cognitoConfigFromEnv({
        ...env,
        OPSLOG_OIDC_REDIRECT_URI: 'http://localhost:5173/auth/callback',
      }).redirectUri,
    ).toBe('http://localhost:5173/auth/callback');
  });
});
