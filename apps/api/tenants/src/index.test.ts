import { describe, expect, it } from 'vitest';
import { TenantApplicationService, type TenantControlStore, type TenantDatabaseProvisioner } from './index.js';
import type { TenantRecord } from '../../../../packages/domain/tenants/src/index.js';

const initial: TenantRecord = {
  id: 'tenant-a',
  name: 'Synthetic A',
  status: 'failed',
  settings: { country: 'MX', timezone: 'America/Mexico_City', currency: 'MXN', language: 'es-MX' },
  authorizationVersion: 1,
  provisioningAttempt: 1,
  failureCode: 'previous_failure',
};

class MemoryStore implements TenantControlStore {
  public tenant = initial;
  public async get(): Promise<TenantRecord> { return this.tenant; }
  public async put(tenant: TenantRecord): Promise<void> { this.tenant = tenant; }
}

describe('tenant API application service', () => {
  it('serializes retries and activates only after successful provisioning', async () => {
    const store = new MemoryStore();
    let calls = 0;
    const provisioner: TenantDatabaseProvisioner = { provision: async () => { calls += 1; } };
    const service = new TenantApplicationService(store, provisioner);
    const [first, second] = await Promise.all([service.provision('tenant-a'), service.provision('tenant-a')]);
    expect(first.status).toBe('active');
    expect(second.status).toBe('active');
    expect(calls).toBe(1);
  });

  it('records failure and refuses active context after a failed attempt', async () => {
    const store = new MemoryStore();
    const service = new TenantApplicationService(store, { provision: async () => { throw new Error('synthetic failure'); } });
    await expect(service.provision('tenant-a')).rejects.toThrow('synthetic failure');
    expect(store.tenant.status).toBe('failed');
    await expect(service.requireActive({ sessionTenantId: 'tenant-a', authorizationVersion: 1 })).rejects.toMatchObject({ status: 409 });
  });
});
