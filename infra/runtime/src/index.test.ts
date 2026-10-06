import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  REQUIRED_GUARDS,
  assertStagingOnly,
  validateDescriptor,
  type RuntimeDescriptor,
} from './index.js';

const root = new URL('..', import.meta.url);
const read = (name: string): string => readFileSync(new URL(name, root), 'utf8');
const descriptor = JSON.parse(read('staging.json')) as RuntimeDescriptor;
const mutate = (patch: Record<string, unknown>): unknown => ({ ...descriptor, ...patch });

describe('staging descriptor guards', () => {
  it('accepts the shipped descriptor', () => {
    expect(validateDescriptor(descriptor)).toEqual([]);
    expect(descriptor.environment).toBe('staging');
    expect(descriptor.production).toBe(false);
    expect(descriptor.awsDeferred).toBe(true);
    expect(descriptor.realCloudCalls).toBe(false);
  });

  it('declares the explicit not-production and AWS-deferred guards', () => {
    const text = descriptor.guards.join('\n').toLowerCase();
    for (const phrase of REQUIRED_GUARDS) expect(text).toContain(phrase);
  });

  it('rejects anything that is not explicitly staging, synthetic and cloud-free', () => {
    expect(validateDescriptor(null)).toEqual(['descriptor must be an object']);
    expect(validateDescriptor([])).toEqual(['descriptor must be an object']);
    const cases: [Record<string, unknown>, string][] = [
      [{ schemaVersion: 2 }, 'schemaVersion must be 1'],
      [{ environment: 'production' }, 'environment must be staging'],
      [{ environment: undefined }, 'environment must be staging'],
      [{ production: true }, 'production must be explicitly false'],
      [{ production: undefined }, 'production must be explicitly false'],
      [{ awsDeferred: false }, 'awsDeferred must be explicitly true'],
      [{ realCloudCalls: true }, 'realCloudCalls must be explicitly false'],
      [{ data: 'customer' }, 'data must be synthetic-only'],
      [{ services: [] }, 'at least one service is required'],
      [{ services: 'api' }, 'at least one service is required'],
      [{ adapters: {} }, 'adapters are required'],
      [{ adapters: undefined }, 'adapters are required'],
      [{ requiredEnv: [] }, 'requiredEnv must include OPSLOG_ENV'],
      [{ pending: [] }, 'pending work must be listed explicitly'],
      [{ pending: undefined }, 'pending work must be listed explicitly'],
    ];
    for (const [patch, expected] of cases)
      expect(validateDescriptor(mutate(patch))).toContain(expected);
  });

  it('rejects real adapters, public or replicated services and invalid compositions', () => {
    const adapters = { ...descriptor.adapters, objectStorage: 's3' };
    expect(validateDescriptor(mutate({ adapters }))).toEqual([
      'adapter objectStorage must be in-memory or synthetic (real adapters are pending)',
    ]);
    const [api] = descriptor.services;
    const withService = (service: unknown) => validateDescriptor(mutate({ services: [service] }));
    expect(withService({ ...api, exposure: 'public' })).toEqual([
      'service api must not be publicly exposed',
    ]);
    expect(withService({ ...api, replicas: 2 })).toEqual([
      'service api must run exactly one replica (state is in memory)',
    ]);
    expect(withService({ ...api, replicas: 0 })).toHaveLength(1);
    expect(withService({ ...api, composition: 'apps/api/files' })).toEqual([
      'service api must use an apps/*/composition module',
    ]);
    expect(withService({})).toEqual(expect.arrayContaining(['service name is required']));
    expect(withService(null)).toEqual(expect.arrayContaining(['service name is required']));
  });

  it('requires every cloud credential name in forbiddenEnv and a complete guard text', () => {
    expect(
      validateDescriptor(
        mutate({ forbiddenEnv: descriptor.forbiddenEnv.filter((n) => n !== 'AWS_PROFILE') }),
      ),
    ).toEqual(['forbiddenEnv must include AWS_PROFILE']);
    expect(validateDescriptor(mutate({ forbiddenEnv: undefined }))).toHaveLength(5);
    expect(validateDescriptor(mutate({ guards: ['Staging only.'] }))).toEqual([
      'guards must state: aws is deferred',
      'guards must state: not production',
    ]);
    expect(validateDescriptor(mutate({ guards: [1, null] }))).toHaveLength(3);
  });

  it.each([
    'arn:aws:s3:::opslog-bucket',
    'bucket.s3.amazonaws.com',
    'db.abc123.us-west-2.rds.example',
    'AKIAABCDEFGHIJKLMNOP',
    '-----BEGIN PRIVATE KEY-----',
    '123456789012',
    'https://staging.example.test',
    'mysql://user@host/db',
  ])('rejects cloud resources, URLs and secrets in the descriptor (%s)', (value) => {
    expect(validateDescriptor(mutate({ name: value }))).toContain(
      'descriptor must not contain cloud resources, endpoints, URLs or secrets',
    );
  });
});

describe('startup guard', () => {
  const ok = { OPSLOG_ENV: 'staging' };
  it('starts only when explicitly marked staging', () => {
    expect(() => assertStagingOnly(ok, descriptor)).not.toThrow();
    expect(() => assertStagingOnly({}, descriptor)).toThrow('OPSLOG_ENV must be staging');
    expect(() => assertStagingOnly({ OPSLOG_ENV: 'production' }, descriptor)).toThrow(
      'OPSLOG_ENV must be staging',
    );
  });
  it('checks the built-in forbidden names even when the descriptor omits them', () => {
    const weak = { forbiddenEnv: ['EXTRA_FORBIDDEN'] };
    expect(() => assertStagingOnly({ ...ok, AWS_ACCESS_KEY_ID: 'x' }, weak)).toThrow(
      'AWS_ACCESS_KEY_ID',
    );
    expect(() => assertStagingOnly({ ...ok, OPSLOG_ALLOW_PRODUCTION: '1' }, weak)).toThrow(
      'OPSLOG_ALLOW_PRODUCTION',
    );
    expect(() => assertStagingOnly({ ...ok, EXTRA_FORBIDDEN: '1' }, weak)).toThrow(
      'EXTRA_FORBIDDEN',
    );
  });
  it('refuses production mode, production switches and cloud credentials', () => {
    expect(() => assertStagingOnly({ ...ok, NODE_ENV: 'production' }, descriptor)).toThrow(
      'production mode is not authorized',
    );
    for (const name of descriptor.forbiddenEnv)
      expect(() => assertStagingOnly({ ...ok, [name]: 'x' }, descriptor)).toThrow(name);
    // An empty value does not count as set.
    expect(() => assertStagingOnly({ ...ok, AWS_PROFILE: '' }, descriptor)).not.toThrow();
  });
});

describe('staging documentation and code hygiene', () => {
  it('states the staging-only, not-production and AWS-deferred guards', () => {
    const doc = read('STAGING.md');
    expect(doc).toMatch(/Solo staging/);
    expect(doc).toMatch(/No es producción/);
    expect(doc).toMatch(/AWS diferido/);
    expect(doc).toMatch(/Sin llamadas reales a la nube/);
    expect(doc).toMatch(/## Pendiente/);
    for (const item of ['TypeORM', 'OIDC', 'CSRF', 'cliente web generado', 'S3 real'])
      expect(doc).toContain(item);
  });
  it('lists the same pending work as the descriptor', () => {
    expect(descriptor.pending).toEqual(
      expect.arrayContaining([
        'persistent TypeORM auth adapter',
        'OIDC verifier',
        'BFF HTTP and CSRF',
        'generated web client',
        'real S3 and IAM',
      ]),
    );
  });
  it('contains no network, cloud SDK or process-spawning code', () => {
    const sources = readdirSync(new URL('src/', root))
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
      .map((file) => read(`src/${file}`).replace(/\/\*[\s\S]*?\*\//g, ''));
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources)
      expect(source).not.toMatch(
        /@aws-sdk|from 'node:(?:http|https|net|child_process)'|fetch\(|require\(/,
      );
  });
});
