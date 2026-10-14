import type { TypeOrmControlPlaneStore } from '../../../../../packages/persistence/identity/src/index.js';
import { MFA_POLICIES, TenantSettingsStore, type TenantSettings } from '../directory.js';

/** Company settings (name, MFA policy, idle hours) written through to the control-plane database. */
export class PersistentTenantSettings extends TenantSettingsStore {
  private constructor(private readonly rows: TypeOrmControlPlaneStore) {
    super();
  }

  public static async open(rows: TypeOrmControlPlaneStore): Promise<PersistentTenantSettings> {
    const store = new PersistentTenantSettings(rows);
    for (const row of await rows.listSettings()) {
      const mfa = MFA_POLICIES.find((policy) => policy === row.mfa);
      if (!mfa) throw new Error('stored company settings have an unknown MFA policy');
      store.set(row.tenantId, { name: row.name, mfa, sessionIdleHours: row.sessionIdleHours });
    }
    return store;
  }

  protected override write(tenantId: string, settings: TenantSettings): Promise<void> {
    return this.rows.upsertSettings({ tenantId, ...settings });
  }
}
