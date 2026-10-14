import type { OidcContext, OidcCompletion, OidcPort, Result } from '../app/types';

/** Public settings of the identity provider's hosted sign-in (no secret: the BFF holds the client secret). */
export interface RedirectOidcConfig {
  /** Hosted UI domain, e.g. `https://<prefix>.auth.<region>.amazoncognito.com`. */
  readonly domain: string;
  readonly clientId: string;
  /** Where the provider sends the browser back; must be registered at the provider. */
  readonly redirectUri: string;
}

export interface RedirectOidcEnv {
  readonly storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  readonly navigate?: (url: string) => void;
  readonly randomBytes?: (length: number) => Uint8Array;
}

const KEY = 'opslog.oidc.pending';
const MAX_AGE_MS = 10 * 60 * 1000;

interface Pending {
  readonly state: string;
  readonly nonce: string;
  readonly verifier: string;
  readonly context: OidcContext;
  readonly at: number;
}

const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const failure = (message: string, status: 400 | 401 | 500 = 400): Result<never> => ({
  ok: false,
  error: { code: 'bad_request', status, message, correlationId: 'oidc-redirect' },
});

/**
 * Identity provider that redirects the browser to the hosted sign-in (authorization code + PKCE S256).
 * What must survive the round trip (state, nonce, verifier, what the person was doing) lives in
 * sessionStorage for this tab only and is consumed on return; the ID token never reaches the browser.
 */
export function createRedirectOidc(
  config: RedirectOidcConfig,
  env: RedirectOidcEnv = {},
): OidcPort {
  const storage = env.storage ?? window.sessionStorage;
  const navigate = env.navigate ?? ((url: string) => window.location.assign(url));
  const random =
    env.randomBytes ?? ((length: number) => crypto.getRandomValues(new Uint8Array(length)));
  return {
    redirects: true,
    authorize: async (_hint, context = {}) => {
      const pending: Pending = {
        state: base64url(random(24)),
        nonce: base64url(random(24)),
        verifier: base64url(random(48)),
        context,
        at: Date.now(),
      };
      const challenge = base64url(
        new Uint8Array(
          await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pending.verifier)),
        ),
      );
      try {
        storage.setItem(KEY, JSON.stringify(pending));
      } catch {
        return failure('No pudimos iniciar el acceso.', 500);
      }
      const url = new URL(`${config.domain}/oauth2/authorize`);
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        scope: 'openid',
        state: pending.state,
        nonce: pending.nonce,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }).toString();
      navigate(url.toString());
      // The page is leaving: the person comes back through the callback route, not through this call.
      return new Promise<never>(() => undefined);
    },
    complete: (search): Result<OidcCompletion> => {
      let raw: string | null = null;
      try {
        raw = storage.getItem(KEY);
        storage.removeItem(KEY);
      } catch {
        raw = null;
      }
      let pending: Pending;
      try {
        pending = JSON.parse(raw ?? '') as Pending;
      } catch {
        return failure('No encontramos un inicio de sesión en curso.');
      }
      const code = search.get('code');
      if (
        search.get('error') ||
        !code ||
        search.get('state') !== pending.state ||
        Date.now() - pending.at > MAX_AGE_MS
      )
        return failure('No pudimos completar el inicio de sesión.', 401);
      return {
        ok: true,
        value: {
          credentials: { code, nonce: pending.nonce, codeVerifier: pending.verifier },
          context: pending.context,
        },
      };
    },
  };
}
