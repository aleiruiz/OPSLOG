import type { JsonWebKey } from 'node:crypto';
import type { ExternalClaims, OidcVerifier } from './index.js';
import { jwtKeyId, verifyRs256, type JwkSet } from './jwt.js';

export interface CognitoOidcConfig {
  /** `https://cognito-idp.<region>.amazonaws.com/<pool id>`: also the `iss` of every token. */
  readonly issuer: string;
  /** Hosted UI domain (token endpoint host), e.g. `https://<prefix>.auth.<region>.amazoncognito.com`. */
  readonly domain: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Exactly the callback the browser used for the authorization request. */
  readonly redirectUri: string;
}

export interface CognitoVerifierOptions {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly clockSkewSeconds?: number;
}

const JWKS_TTL_MS = 60 * 60 * 1000;
const JWKS_REFRESH_MIN_MS = 60 * 1000;

const required = (env: Readonly<Record<string, string | undefined>>, name: string): string => {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const httpsOrLocal = (name: string, value: string): string => {
  const url = new URL(value);
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
    throw new Error(`${name} must be https`);
  return value;
};

/** Reads the OIDC settings from the environment; nothing is defaulted and no secret has a fallback. */
export function cognitoConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): CognitoOidcConfig {
  return {
    issuer: httpsOrLocal('OPSLOG_OIDC_ISSUER', required(env, 'OPSLOG_OIDC_ISSUER')).replace(
      /\/+$/,
      '',
    ),
    domain: httpsOrLocal('OPSLOG_OIDC_DOMAIN', required(env, 'OPSLOG_OIDC_DOMAIN')).replace(
      /\/+$/,
      '',
    ),
    clientId: required(env, 'OPSLOG_OIDC_CLIENT_ID'),
    clientSecret: required(env, 'OPSLOG_OIDC_CLIENT_SECRET'),
    redirectUri: httpsOrLocal(
      'OPSLOG_OIDC_REDIRECT_URI',
      required(env, 'OPSLOG_OIDC_REDIRECT_URI'),
    ),
  };
}

/**
 * Server-side verifier for Amazon Cognito: exchanges the authorization code (with the PKCE verifier
 * and the confidential client's secret) at the token endpoint, then validates the ID token's
 * signature against the pool's JWKS, issuer, audience, token use, time claims and nonce. The tokens
 * never leave this function; only the verified claims are returned.
 */
export function createCognitoVerifier(
  config: CognitoOidcConfig,
  options: CognitoVerifierOptions = {},
): OidcVerifier {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const skew = options.clockSkewSeconds ?? 60;
  let keys: readonly JsonWebKey[] = [];
  let fetchedAt = -Infinity;

  const loadKeys = async (): Promise<void> => {
    const response = await doFetch(`${config.issuer}/.well-known/jwks.json`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error('jwks unavailable');
    const set = (await response.json()) as Partial<JwkSet>;
    if (!Array.isArray(set.keys)) throw new Error('jwks malformed');
    keys = set.keys;
    fetchedAt = now();
  };

  const keyFor = async (kid: string): Promise<JsonWebKey> => {
    const find = () => keys.find((key) => (key as { kid?: string }).kid === kid);
    if (now() - fetchedAt > JWKS_TTL_MS) await loadKeys();
    let key = find();
    // An unknown key id may mean a rotation; refresh at most once a minute.
    if (!key && now() - fetchedAt > JWKS_REFRESH_MIN_MS) {
      await loadKeys();
      key = find();
    }
    if (!key) throw new Error('unknown signing key');
    return key;
  };

  const exchange = async (code: string, codeVerifier: string): Promise<string> => {
    const response = await doFetch(`${config.domain}/oauth2/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: config.clientId,
        code,
        redirect_uri: config.redirectUri,
        code_verifier: codeVerifier,
      }).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error('code rejected');
    const tokens = (await response.json()) as { id_token?: unknown };
    if (typeof tokens.id_token !== 'string' || !tokens.id_token) throw new Error('no id token');
    return tokens.id_token;
  };

  return {
    async verify(code, expectedIssuer, expectedNonce, codeVerifier): Promise<ExternalClaims> {
      if (expectedIssuer !== config.issuer || !codeVerifier) throw new Error('rejected');
      const idToken = await exchange(code, codeVerifier);
      const claims = verifyRs256(idToken, await keyFor(jwtKeyId(idToken)));
      const seconds = Math.floor(now() / 1000);
      const {
        iss,
        aud,
        sub,
        exp,
        iat,
        nonce,
        token_use: use,
        email_verified: emailVerified,
      } = claims;
      if (
        iss !== config.issuer ||
        aud !== config.clientId ||
        use !== 'id' ||
        typeof sub !== 'string' ||
        typeof exp !== 'number' ||
        exp + skew < seconds ||
        (typeof iat === 'number' && iat - skew > seconds) ||
        typeof nonce !== 'string' ||
        nonce !== expectedNonce
      )
        throw new Error('invalid id token');
      return {
        issuer: iss,
        subject: sub,
        nonce,
        ...(typeof emailVerified === 'boolean' ? { emailVerified } : {}),
      };
    },
  };
}
