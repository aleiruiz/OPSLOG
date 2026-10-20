import { afterAll, afterEach, beforeAll, describe, it } from 'vitest';
import { TypeOrmSavedViewStore } from '../../../packages/persistence/saved-views/src/index.js';
import {
  adminUrl,
  startSavedViewsDatabase,
  type SavedViewsDatabase,
} from '../../../packages/persistence/saved-views/src/test-support/mysql.js';
import {
  namesVersionsAndLimit,
  permissionsAndRevalidation,
  tenantIsolation,
  viewsCompany,
} from './saved-views-scenarios.js';
import { createWorld, type World } from './world.js';

/**
 * The platform on the real MySQL saved-views store (CI: mysql service, OPSLOG_TEST_MYSQL_ADMIN_URL;
 * locally skipped when unset). The other modules stay in memory. Only synthetic data.
 */
const suite = adminUrl ? describe : describe.skip;

suite('Platform on the real MySQL saved views', () => {
  let database: SavedViewsDatabase;
  let store: TypeOrmSavedViewStore;
  let world: World;

  beforeAll(async () => {
    database = await startSavedViewsDatabase('plat');
    store = new TypeOrmSavedViewStore(await database.openRuntime());
  });
  afterEach(() => world?.dispose());
  afterAll(async () => database?.close());

  it('isolates companies', async () => {
    world = createWorld({ adapters: { savedViews: store } } as never);
    await tenantIsolation(
      world,
      await viewsCompany(world, 'Empresa Alfa', 'a'),
      await viewsCompany(world, 'Empresa Beta', 'b'),
    );
  });

  it('revalidates by grants, keeps names unique, guards versions and limits to 50', async () => {
    world = createWorld({ adapters: { savedViews: store } } as never);
    const company = await viewsCompany(world, 'Empresa Gamma', 'g');
    await permissionsAndRevalidation(world, company);
    await namesVersionsAndLimit(world, company);
  });
});
