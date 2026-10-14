import { describe, expect, it } from 'vitest';
import { InMemoryAuditStore } from '../../../../packages/platform/audit/src/index.js';
import {
  createPlatform,
  FakeOidcVerifier,
  InMemoryTenantStore,
} from '../../composition/src/index.js';
import { bootstrapFirstCompany } from './bootstrap.js';

const issuer = 'https://cognito-idp.test.example/pool-1';
const input = { companyName: 'Demo SA', adminSubject: 'sub-admin-1' };

const newPlatform = () => {
  const verifier = new FakeOidcVerifier(issuer);
  return createPlatform({
    verifier,
    issuer,
    grantSecret: 'g'.repeat(32),
    environment: 'staging',
    adapters: {
      tenants: new InMemoryTenantStore(),
      audit: new InMemoryAuditStore(),
      auditRelay: { runBatch: async () => 0 },
    },
  });
};

describe('bootstrapFirstCompany', () => {
  it('creates the company once and skips when the admin already has a membership', async () => {
    const platform = newPlatform();
    const first = await bootstrapFirstCompany(platform, issuer, input);
    expect(first).toMatch(/^bootstrap_created/);
    const second = await bootstrapFirstCompany(platform, issuer, input);
    expect(second).toMatch(/^bootstrap_skipped/);
    expect(`${first} ${second}`).not.toContain(input.adminSubject);
    expect(`${first} ${second}`).not.toContain(input.companyName);
  });

  it('fails without leaking the cause when the company cannot be created', async () => {
    await expect(
      bootstrapFirstCompany(newPlatform(), issuer, { ...input, companyName: 'x'.repeat(200) }),
    ).rejects.toThrow('bootstrap of the first company failed');
  });
});
