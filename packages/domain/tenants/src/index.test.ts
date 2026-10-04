import { describe, expect, it } from 'vitest';
import { completeProvisioning, failProvisioning, startProvisioning, type TenantRecord } from './index.js';

const tenant: TenantRecord = {
  id: 'tenant-a',
  name: 'Synthetic A',
  status: 'provisioning',
  settings: { country: 'MX', timezone: 'America/Mexico_City', currency: 'MXN', language: 'es-MX' },
  authorizationVersion: 1,
  provisioningAttempt: 1,
};

describe('tenant lifecycle', () => {
  it('does not activate before provisioning completes', () => {
    expect(startProvisioning({ ...tenant, status: 'failed' }).tenant.status).toBe('provisioning');
    expect(completeProvisioning(tenant).tenant.status).toBe('active');
  });

  it('keeps a failed provisioning attempt non-active', () => {
    const result = failProvisioning(tenant, 'migration_failed');
    expect(result.tenant.status).toBe('failed');
    expect(result.tenant.failureCode).toBe('migration_failed');
  });
});
