import {
  S3ObjectStorage,
  type ObjectStorage,
} from '../../../../packages/platform/files/src/index.js';
import { AwsS3ObjectClient } from '../../../../infra/storage/src/aws-client.js';

export type ObjectStorageKind = 'in-memory' | 's3';

/**
 * Builds the S3 adapter from OPSLOG_S3_* variables. Dedicated names are used on purpose: the
 * staging guard forbids ambient AWS_* credentials, so the app role's keys are never picked up
 * implicitly. Nothing here is committed: bucket, region and keys come from the environment.
 */
export function s3ObjectStorageFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): ObjectStorage {
  const read = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required for the s3 object storage adapter`);
    return value;
  };
  const endpoint = env.OPSLOG_S3_ENDPOINT?.trim();
  if (endpoint && env.NODE_ENV !== 'test')
    throw new Error('OPSLOG_S3_ENDPOINT is only allowed when NODE_ENV=test');
  const kmsKeyId = env.OPSLOG_S3_KMS_KEY_ID?.trim();
  return new S3ObjectStorage({
    bucket: read('OPSLOG_S3_BUCKET'),
    ...(kmsKeyId ? { kmsKeyId } : {}),
    client: new AwsS3ObjectClient({
      region: read('OPSLOG_S3_REGION'),
      accessKeyId: read('OPSLOG_S3_ACCESS_KEY_ID'),
      secretAccessKey: read('OPSLOG_S3_SECRET_ACCESS_KEY'),
      ...(endpoint ? { endpoint } : {}),
    }),
  });
}
