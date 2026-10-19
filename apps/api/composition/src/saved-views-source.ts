import {
  createSavedViewsDataSource,
  createSavedViewsMigrationDataSource,
  runSavedViewsMigrations,
  SAVED_VIEWS_MIGRATION_VERSION,
  TypeOrmSavedViewStore,
  type SavedViewsDatabaseConfig,
} from '../../../../packages/persistence/saved-views/src/index.js';

type Endpoint = Pick<SavedViewsDatabaseConfig, 'host' | 'port' | 'database'>;
type Account = Pick<SavedViewsDatabaseConfig, 'username' | 'password'>;

/** Saved views schema step: independent of the other modules, it only names the company and the member. */
export function savedViewsMigrationSteps(endpoint: Endpoint, migrator: Account) {
  return [
    {
      name: 'saved_views',
      version: SAVED_VIEWS_MIGRATION_VERSION,
      source: createSavedViewsMigrationDataSource({ ...endpoint, ...migrator }),
      run: runSavedViewsMigrations,
    },
  ] as const;
}

/** Uninitialized source; the caller initializes it so a failed startup closes it. */
export function createSavedViewsRuntimeSource(
  endpoint: Omit<SavedViewsDatabaseConfig, 'username' | 'password'>,
  account: Account,
) {
  return createSavedViewsDataSource({ ...endpoint, ...account });
}

export function savedViewsRuntimeAdapters(
  source: ReturnType<typeof createSavedViewsRuntimeSource>,
) {
  return { savedViews: new TypeOrmSavedViewStore(source) };
}
