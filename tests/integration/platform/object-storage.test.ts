import { describe, expect, it } from 'vitest';
import { s3ObjectStorageFromEnv } from '../../../apps/api/composition/src/index.js';

const env = {
  OPSLOG_S3_BUCKET: 'bucket-for-test',
  OPSLOG_S3_REGION: 'us-east-1',
  OPSLOG_S3_ACCESS_KEY_ID: 'test-key',
  OPSLOG_S3_SECRET_ACCESS_KEY: 'test-secret',
};

describe('s3ObjectStorageFromEnv', () => {
  it('builds the adapter from OPSLOG_S3_* without contacting S3', () => {
    expect(s3ObjectStorageFromEnv(env)).toBeDefined();
    expect(
      s3ObjectStorageFromEnv({
        ...env,
        NODE_ENV: 'test',
        OPSLOG_S3_ENDPOINT: 'http://127.0.0.1:1',
        OPSLOG_S3_KMS_KEY_ID: 'k',
      }),
    ).toBeDefined();
  });
  it('refuses a custom endpoint outside tests', () => {
    expect(() =>
      s3ObjectStorageFromEnv({ ...env, NODE_ENV: 'production', OPSLOG_S3_ENDPOINT: 'http://x' }),
    ).toThrow('only allowed');
  });
  it.each(Object.keys(env))('requires %s and ignores ambient AWS_* credentials', (name) => {
    const missing = { ...env, [name]: ' ', AWS_ACCESS_KEY_ID: 'ambient' };
    expect(() => s3ObjectStorageFromEnv(missing)).toThrow(`${name} is required`);
  });
});
