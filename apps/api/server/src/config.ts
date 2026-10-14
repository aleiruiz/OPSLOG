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
  readonly authMode: 'synthetic';
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

  const authMode = env.OPSLOG_AUTH_MODE?.trim() || 'synthetic';
  // The real Cognito verifier is added by its own change; until then only the synthetic one exists.
  if (authMode !== 'synthetic') throw new Error('OPSLOG_AUTH_MODE must be synthetic in this build');

  return {
    host: env.HOST?.trim() || '0.0.0.0',
    port,
    publicOrigin: origin,
    bffSecret,
    grantSecret,
    authMode,
  };
}
