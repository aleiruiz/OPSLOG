import {
  cognitoConfigFromEnv,
  type CognitoOidcConfig,
} from '../../../../packages/platform/auth/src/cognito.js';

/** Everything the server reads from the environment, validated once at start-up. */
export interface ServerConfig {
  readonly host: string;
  readonly port: number;
  /** The single public origin (scheme + host) browsers use, e.g. the Coolify domain. */
  readonly publicOrigin: string;
  /** Secret for CSRF tokens and signed cursors (at least 32 characters). */
  readonly bffSecret: string;
  /** Secret for download grants (at least 32 characters). */
  readonly grantSecret: string;
  /** `synthetic` is for local runs only; `cognito` verifies real Amazon Cognito sign-ins. */
  readonly authMode: 'synthetic' | 'cognito';
  /** Present exactly when `authMode` is `cognito`. */
  readonly oidc?: CognitoOidcConfig;
  /** First company and its first administrator (Cognito `sub`), created at start-up when both are set. */
  readonly bootstrap?: { readonly companyName: string; readonly adminSubject: string };
  /** `s3` also needs the OPSLOG_S3_* variables (read by the S3 adapter itself). */
  readonly objectStorage: 'memory' | 's3';
}

export type Env = Readonly<Record<string, string | undefined>>;

const MIN_SECRET = 32;

function required(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/** Parses the process environment. Messages name the variable, never its value. */
export function readConfig(env: Env): ServerConfig {
  const port = Number(env.PORT?.trim() || '8080');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT is not a port');

  const origin = required(env, 'OPSLOG_PUBLIC_ORIGIN');
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error('OPSLOG_PUBLIC_ORIGIN must be an origin such as https://host');
  }
  const loopback = ['localhost', '127.0.0.1'].includes(parsed.hostname);
  if (
    parsed.origin !== origin ||
    (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback))
  )
    throw new Error('OPSLOG_PUBLIC_ORIGIN must be an https origin without path (http on loopback)');

  const bffSecret = required(env, 'OPSLOG_BFF_SECRET');
  const grantSecret = required(env, 'OPSLOG_GRANT_SECRET');
  if (bffSecret.length < MIN_SECRET)
    throw new Error(`OPSLOG_BFF_SECRET needs at least ${MIN_SECRET} characters`);
  if (grantSecret.length < MIN_SECRET)
    throw new Error(`OPSLOG_GRANT_SECRET needs at least ${MIN_SECRET} characters`);

  if (bffSecret === grantSecret)
    throw new Error('OPSLOG_GRANT_SECRET must differ from OPSLOG_BFF_SECRET');

  const objectStorage = env.OPSLOG_OBJECT_STORAGE?.trim() || 'memory';
  if (objectStorage !== 'memory' && objectStorage !== 's3')
    throw new Error('OPSLOG_OBJECT_STORAGE must be memory or s3');

  const authMode = env.OPSLOG_AUTH_MODE?.trim() || 'synthetic';
  if (authMode !== 'synthetic' && authMode !== 'cognito')
    throw new Error('OPSLOG_AUTH_MODE must be synthetic or cognito');
  let oidc: CognitoOidcConfig | undefined;
  if (authMode === 'cognito') {
    try {
      oidc = cognitoConfigFromEnv(env);
    } catch (error) {
      // cognitoConfigFromEnv names the variable; a malformed URL would echo nothing useful, so mask it.
      const message = error instanceof Error ? error.message : '';
      throw new Error(
        /^OPSLOG_OIDC_[A-Z_]+ (is required|must be https)$/.test(message)
          ? message
          : 'OPSLOG_OIDC_ISSUER, OPSLOG_OIDC_DOMAIN and OPSLOG_OIDC_REDIRECT_URI must be URLs',
      );
    }
    // The web app always returns to `${origin}/auth/callback`; any other value fails every code exchange.
    if (oidc.redirectUri !== `${origin}/auth/callback`)
      throw new Error('OPSLOG_OIDC_REDIRECT_URI must be OPSLOG_PUBLIC_ORIGIN + /auth/callback');
  }

  const companyName = env.OPSLOG_BOOTSTRAP_COMPANY?.trim();
  const adminSubject = env.OPSLOG_BOOTSTRAP_ADMIN_SUB?.trim();
  if (Boolean(companyName) !== Boolean(adminSubject))
    throw new Error('OPSLOG_BOOTSTRAP_COMPANY and OPSLOG_BOOTSTRAP_ADMIN_SUB must be set together');
  if (companyName && companyName.length > 160)
    throw new Error('OPSLOG_BOOTSTRAP_COMPANY is longer than 160 characters');
  if (adminSubject && adminSubject.length > 200)
    throw new Error('OPSLOG_BOOTSTRAP_ADMIN_SUB is longer than 200 characters');

  return {
    host: env.HOST?.trim() || '0.0.0.0',
    port,
    publicOrigin: origin,
    bffSecret,
    grantSecret,
    authMode,
    ...(oidc ? { oidc } : {}),
    ...(companyName && adminSubject ? { bootstrap: { companyName, adminSubject } } : {}),
    objectStorage,
  };
}
