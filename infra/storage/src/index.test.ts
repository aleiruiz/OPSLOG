import { describe, expect, it } from 'vitest';
import {
  privateBucketConfig,
  validateAppPolicy,
  validateBucketConfig,
  type BucketConfig,
  type PolicyStatement,
} from './index.js';

const base = privateBucketConfig('opslog-synthetic-files', 'alias/opslog-files');
const problems = (over: Partial<BucketConfig>) => validateBucketConfig({ ...base, ...over });

describe('private bucket configuration rules', () => {
  it('accepts the default private configuration', () => {
    expect(validateBucketConfig(base)).toEqual([]);
  });
  it('reports each way the bucket could become publicly readable or unencrypted', () => {
    expect(problems({ blockPublicAcls: false })).toHaveLength(1);
    expect(problems({ ignorePublicAcls: false })).toHaveLength(1);
    expect(problems({ blockPublicPolicy: false })).toHaveLength(1);
    expect(problems({ restrictPublicBuckets: false })).toHaveLength(1);
    expect(problems({ objectOwnership: 'ObjectWriter' })).toHaveLength(1);
    expect(problems({ versioning: 'Suspended' })).toHaveLength(1);
    expect(problems({ enforceTls: false })).toHaveLength(1);
    expect(problems({ corsAllowedOrigins: ['https://example.test'] })).toHaveLength(1);
    expect(problems({ encryption: { algorithm: 'AES256' } })).toHaveLength(1);
    expect(problems({ encryption: { algorithm: 'aws:kms', kmsKeyId: ' ' } })).toHaveLength(1);
    expect(problems({ quarantineExpiryDays: 0 })).toHaveLength(1);
    expect(problems({ name: 'Bad_Name' })).toHaveLength(1);
  });
});

describe('application role policy rules', () => {
  const allow = (over: Partial<PolicyStatement> = {}): PolicyStatement => ({
    effect: 'Allow',
    principal: 'arn:aws:iam::000000000000:role/opslog-api',
    actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
    resources: ['arn:aws:s3:::opslog-synthetic-files/tenants/*'],
    ...over,
  });
  it('accepts object CRUD under the tenants prefix', () => {
    expect(validateAppPolicy('opslog-synthetic-files', [allow()])).toEqual([]);
  });
  it('rejects wildcard actions, public principals and resources outside the prefix', () => {
    expect(
      validateAppPolicy('opslog-synthetic-files', [allow({ actions: ['s3:*'] })]),
    ).toHaveLength(1);
    expect(
      validateAppPolicy('opslog-synthetic-files', [allow({ actions: ['s3:PutBucketPolicy'] })]),
    ).toHaveLength(1);
    expect(validateAppPolicy('opslog-synthetic-files', [allow({ principal: '*' })])).toHaveLength(
      1,
    );
    expect(
      validateAppPolicy('opslog-synthetic-files', [
        allow({ resources: ['arn:aws:s3:::opslog-synthetic-files/*'] }),
      ]),
    ).toHaveLength(1);
    expect(
      validateAppPolicy('opslog-synthetic-files', [
        allow({ resources: ['arn:aws:s3:::other/tenants/*'] }),
      ]),
    ).toHaveLength(1);
    expect(
      validateAppPolicy('opslog-synthetic-files', [
        allow({ resources: ['arn:aws:s3:::opslog-synthetic-files/tenants/*/*'] }),
      ]),
    ).toHaveLength(1);
  });
  it('does not evaluate Deny statements as grants', () => {
    expect(
      validateAppPolicy('opslog-synthetic-files', [
        allow(),
        allow({ effect: 'Deny', principal: '*', actions: ['s3:*'] }),
      ]),
    ).toEqual([]);
  });
});
