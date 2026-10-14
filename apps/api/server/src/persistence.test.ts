import { describe, expect, it } from 'vitest';
import { ACCOUNT_TAG, runMigrate } from './persistence.js';
import { buildFleetAccounts, deriveAccountPassword } from '../../composition/src/index.js';

describe('MySQL account provisioning', () => {
  it('derives stable, distinct passwords per account from one secret', () => {
    const secret = 's'.repeat(40);
    expect(deriveAccountPassword(secret, 'opslog_areas_app')).toBe(
      deriveAccountPassword(secret, 'opslog_areas_app'),
    );
    expect(deriveAccountPassword(secret, 'opslog_areas_app')).not.toBe(
      deriveAccountPassword(secret, 'opslog_vehicles_app'),
    );
    expect(deriveAccountPassword(secret, 'opslog_areas_app')).not.toBe(
      deriveAccountPassword('t'.repeat(40), 'opslog_areas_app'),
    );
    expect(deriveAccountPassword(secret, 'opslog_areas_app')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('names every account within the MySQL limit and the module naming rules', () => {
    const set = buildFleetAccounts(ACCOUNT_TAG, ACCOUNT_TAG, (username) => username);
    const names = [
      ...Object.values(set.runtime),
      set.identity,
      set.auditMigrator,
      set.filesMigrator,
      set.maintenanceMigrator,
    ].map((account) => account.username);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name.length).toBeLessThanOrEqual(32);
    expect(() => buildFleetAccounts('x'.repeat(40), 'app', (u) => u)).toThrow('too long');
  });

  it('refuses to migrate without the admin password variable', async () => {
    await expect(
      runMigrate({ OPSLOG_MYSQL_SECRET: 's'.repeat(32) }, () => undefined),
    ).rejects.toThrow('OPSLOG_MYSQL_ROOT_PASSWORD is required');
  });
});
