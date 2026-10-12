import { describe, expect, it } from 'vitest';
import { TypeOrmMaintenancePlanStore } from './store.js';

const source = (options: Record<string, unknown>) => ({ options }) as never;

describe('TypeOrmMaintenancePlanStore configuration', () => {
  it('requires MySQL, schema synchronization off, and a dedicated maintenance runtime account', () => {
    expect(
      () =>
        new TypeOrmMaintenancePlanStore(
          source({ type: 'sqlite', username: 'opslog_maintenance_api', synchronize: false }),
        ),
    ).toThrow(/MySQL/);
    expect(
      () =>
        new TypeOrmMaintenancePlanStore(
          source({ type: 'mysql', username: 'opslog_maintenance_api', synchronize: true }),
        ),
    ).toThrow(/synchronize disabled/);
    expect(
      () =>
        new TypeOrmMaintenancePlanStore(
          source({ type: 'mysql', username: 'root', synchronize: false }),
        ),
    ).toThrow(/restricted runtime account/);
    expect(
      () =>
        new TypeOrmMaintenancePlanStore(
          source({ type: 'mysql', username: 'opslog_maintenance_api', synchronize: false }),
        ),
    ).not.toThrow();
  });
});
