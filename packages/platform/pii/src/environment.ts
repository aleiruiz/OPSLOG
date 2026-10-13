const PRODUCTION = /^(?:production|prod)$/i;

/**
 * Whether the deployment announces production: the mode given, `NODE_ENV` or `OPSLOG_ENV` is
 * `production` or `prod` (any case, trimmed). One rule for every fail-closed start-up check.
 */
export function isProductionMode(
  environment?: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return [environment, env['NODE_ENV'], env['OPSLOG_ENV']].some(
    (value) => typeof value === 'string' && PRODUCTION.test(value.trim()),
  );
}
