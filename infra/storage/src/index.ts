/**
 * Declarative description of the private object bucket and its application role, with validators.
 * No AWS SDK, no network, no credentials: AWS is deferred (ADR-0002), so this is the contract a
 * future IaC/adapter must satisfy, checked by unit tests only.
 */
export interface BucketConfig {
  readonly name: string;
  readonly blockPublicAcls: boolean;
  readonly ignorePublicAcls: boolean;
  readonly blockPublicPolicy: boolean;
  readonly restrictPublicBuckets: boolean;
  readonly objectOwnership: 'BucketOwnerEnforced' | 'BucketOwnerPreferred' | 'ObjectWriter';
  readonly versioning: 'Enabled' | 'Suspended' | 'Off';
  readonly encryption: { readonly algorithm: 'aws:kms' | 'AES256'; readonly kmsKeyId?: string };
  readonly enforceTls: boolean;
  readonly corsAllowedOrigins: readonly string[];
  /** Days after which unreleased quarantine objects expire. */
  readonly quarantineExpiryDays: number;
}

const BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

export function privateBucketConfig(name: string, kmsKeyId: string): BucketConfig {
  return {
    name,
    blockPublicAcls: true,
    ignorePublicAcls: true,
    blockPublicPolicy: true,
    restrictPublicBuckets: true,
    objectOwnership: 'BucketOwnerEnforced',
    versioning: 'Enabled',
    encryption: { algorithm: 'aws:kms', kmsKeyId },
    enforceTls: true,
    corsAllowedOrigins: [],
    quarantineExpiryDays: 7,
  };
}

/** Returns human-readable problems; an empty list means the config meets the private-bucket rules. */
export function validateBucketConfig(config: BucketConfig): readonly string[] {
  const problems: string[] = [];
  if (!BUCKET_NAME.test(config.name)) problems.push('bucket name is invalid');
  if (
    !config.blockPublicAcls ||
    !config.ignorePublicAcls ||
    !config.blockPublicPolicy ||
    !config.restrictPublicBuckets
  )
    problems.push('all four public access blocks must be enabled');
  if (config.objectOwnership !== 'BucketOwnerEnforced')
    problems.push('ACLs must be disabled with BucketOwnerEnforced');
  if (config.versioning !== 'Enabled') problems.push('versioning must be enabled');
  if (config.encryption.algorithm !== 'aws:kms' || !config.encryption.kmsKeyId?.trim())
    problems.push('SSE-KMS with an explicit key is required');
  if (!config.enforceTls) problems.push('TLS-only access must be enforced');
  if (config.corsAllowedOrigins.length > 0)
    problems.push('browsers must not read the bucket directly: CORS origins must be empty');
  if (!Number.isInteger(config.quarantineExpiryDays) || config.quarantineExpiryDays < 1)
    problems.push('quarantine objects need an expiry');
  return problems;
}

export interface PolicyStatement {
  readonly effect: 'Allow' | 'Deny';
  readonly principal: string;
  readonly actions: readonly string[];
  readonly resources: readonly string[];
}

const APP_ACTIONS: readonly string[] = ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'];

/** Least-privilege check for the application role: object CRUD under the tenant prefix, no wildcards. */
export function validateAppPolicy(
  bucketName: string,
  statements: readonly PolicyStatement[],
): readonly string[] {
  const problems: string[] = [];
  for (const statement of statements) {
    if (statement.effect === 'Deny') continue;
    if (statement.principal === '*')
      problems.push('Allow statements must not use a public principal');
    for (const action of statement.actions)
      if (!APP_ACTIONS.includes(action)) problems.push(`action ${action} is not permitted`);
    for (const resource of statement.resources)
      if (!resource.startsWith(`arn:aws:s3:::${bucketName}/tenants/`) || resource.includes('*/*'))
        problems.push(`resource ${resource} is outside the tenant object prefix`);
  }
  return problems;
}

/**
 * Port for a future real S3 adapter (not implemented: AWS integration is deferred). Operations are
 * server-side only; the adapter must not return presigned URLs to browsers.
 */
export interface S3ObjectClient {
  putObject(input: {
    bucket: string;
    key: string;
    body: Uint8Array;
    contentType: string;
    ifNoneMatch: '*';
    kmsKeyId: string;
  }): Promise<void>;
  getObject(input: { bucket: string; key: string }): Promise<Uint8Array | null>;
  deleteObject(input: { bucket: string; key: string }): Promise<void>;
}
