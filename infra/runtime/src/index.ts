/**
 * Staging-only runtime descriptor and its guards. It describes how the in-memory platform
 * composition (apps/api/composition, apps/worker/composition) is run for a controlled staging
 * check. It is data plus validators: no AWS SDK, no network, no credentials. AWS is deferred
 * (ADR-0002) and production is not authorized, so anything that looks like a cloud resource, a
 * secret or a production switch is rejected.
 */
export interface RuntimeService {
  readonly name: string;
  readonly composition: string;
  readonly replicas: number;
  readonly exposure: 'internal' | 'none';
}

export type AdapterKind = 'in-memory' | 'synthetic';

export interface RuntimeDescriptor {
  readonly schemaVersion: 1;
  readonly name: string;
  readonly environment: 'staging';
  readonly production: false;
  readonly awsDeferred: true;
  readonly realCloudCalls: false;
  readonly data: 'synthetic-only';
  readonly services: readonly RuntimeService[];
  readonly adapters: Readonly<Record<string, AdapterKind>>;
  readonly requiredEnv: readonly string[];
  readonly forbiddenEnv: readonly string[];
  readonly guards: readonly string[];
  readonly pending: readonly string[];
}

/** Patterns that would indicate a real cloud resource, endpoint or secret inside the descriptor. */
const CLOUD_OR_SECRET =
  /arn:aws|amazonaws\.com|\.rds\.|AKIA[A-Z0-9]{16}|-----BEGIN|\b\d{12}\b|[a-z][a-z0-9+.-]*:\/\//i;

/** Environment names that must be set or unset for the process to start in staging. */
export const REQUIRED_GUARDS: readonly string[] = [
  'staging only',
  'aws is deferred',
  'not production',
];

export const REQUIRED_FORBIDDEN_ENV: readonly string[] = [
  'OPSLOG_ALLOW_PRODUCTION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_PROFILE',
  'AWS_ROLE_ARN',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_CONTAINER_CREDENTIALS_*',
];

/** Returns human-readable problems; an empty list means the descriptor meets the staging-only rules. */
export function validateDescriptor(value: unknown): readonly string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return ['descriptor must be an object'];
  const d = value as Record<string, unknown>;
  const problems: string[] = [];
  if (d.schemaVersion !== 1) problems.push('schemaVersion must be 1');
  if (d.environment !== 'staging') problems.push('environment must be staging');
  if (d.production !== false) problems.push('production must be explicitly false');
  if (d.awsDeferred !== true) problems.push('awsDeferred must be explicitly true');
  if (d.realCloudCalls !== false) problems.push('realCloudCalls must be explicitly false');
  if (d.data !== 'synthetic-only') problems.push('data must be synthetic-only');

  const services = Array.isArray(d.services) ? (d.services as unknown[]) : null;
  if (!services || services.length === 0) problems.push('at least one service is required');
  for (const service of services ?? []) {
    const s = (service ?? {}) as Record<string, unknown>;
    if (typeof s.name !== 'string' || !s.name) problems.push('service name is required');
    if (
      typeof s.composition !== 'string' ||
      !/^apps\/(api|worker)\/composition$/.test(s.composition)
    )
      problems.push(`service ${String(s.name)} must use an apps/*/composition module`);
    if (!Number.isInteger(s.replicas) || (s.replicas as number) < 1 || (s.replicas as number) > 1)
      problems.push(`service ${String(s.name)} must run exactly one replica (state is in memory)`);
    if (s.exposure !== 'internal' && s.exposure !== 'none')
      problems.push(`service ${String(s.name)} must not be publicly exposed`);
  }

  const adapters = (d.adapters ?? null) as Record<string, unknown> | null;
  if (!adapters || typeof adapters !== 'object' || Object.keys(adapters).length === 0)
    problems.push('adapters are required');
  for (const [name, kind] of Object.entries(adapters ?? {}))
    if (kind !== 'in-memory' && kind !== 'synthetic')
      problems.push(`adapter ${name} must be in-memory or synthetic (real adapters are pending)`);

  const required = Array.isArray(d.requiredEnv) ? (d.requiredEnv as unknown[]) : [];
  if (!required.includes('OPSLOG_ENV')) problems.push('requiredEnv must include OPSLOG_ENV');
  const forbidden = Array.isArray(d.forbiddenEnv) ? (d.forbiddenEnv as unknown[]) : [];
  for (const name of REQUIRED_FORBIDDEN_ENV)
    if (!forbidden.includes(name)) problems.push(`forbiddenEnv must include ${name}`);

  const guards = Array.isArray(d.guards) ? (d.guards as unknown[]) : [];
  const guardText = guards
    .filter((g): g is string => typeof g === 'string')
    .join('\n')
    .toLowerCase();
  for (const phrase of REQUIRED_GUARDS)
    if (!guardText.includes(phrase)) problems.push(`guards must state: ${phrase}`);
  if (!Array.isArray(d.pending) || d.pending.length === 0)
    problems.push('pending work must be listed explicitly');

  if (CLOUD_OR_SECRET.test(JSON.stringify(d)))
    problems.push('descriptor must not contain cloud resources, endpoints, URLs or secrets');
  return problems;
}

/**
 * Startup guard: refuses to run unless the process is explicitly marked as staging and carries no
 * production switch or cloud credential. It never reads files or contacts a service.
 */
export function assertStagingOnly(
  env: Readonly<Record<string, string | undefined>>,
  descriptor: RuntimeDescriptor,
): void {
  const problems = validateDescriptor(descriptor);
  if (problems.length > 0)
    throw new Error(`refusing to start: invalid descriptor (${problems.join('; ')})`);
  if (env.OPSLOG_ENV !== 'staging')
    throw new Error('refusing to start: OPSLOG_ENV must be staging');
  if (env.NODE_ENV?.trim().toLowerCase() === 'production')
    throw new Error('refusing to start: production mode is not authorized');
  // A trailing `*` forbids every variable with that prefix.
  for (const name of new Set([...REQUIRED_FORBIDDEN_ENV, ...descriptor.forbiddenEnv])) {
    const prefix = name.endsWith('*') ? name.slice(0, -1) : null;
    const hit = Object.keys(env).find(
      (key) => (prefix === null ? key === name : key.startsWith(prefix)) && env[key],
    );
    if (hit) throw new Error(`refusing to start: ${hit} must not be set in staging`);
  }
}
