import {
  createSearchDataSource,
  createSearchMigrationDataSource,
  runSearchMigrations,
  SEARCH_MIGRATION_VERSION,
  TypeOrmSearchStore,
  type SearchDatabaseConfig,
} from '../../../../packages/persistence/search/src/index.js';

type Endpoint = Pick<SearchDatabaseConfig, 'host' | 'port' | 'database'>;
type Account = Pick<SearchDatabaseConfig, 'username' | 'password'>;

/** Search schema step: the projection of the global search, after the modules it indexes. */
export function searchMigrationSteps(endpoint: Endpoint, migrator: Account) {
  return [
    {
      name: 'search',
      version: SEARCH_MIGRATION_VERSION,
      source: createSearchMigrationDataSource({ ...endpoint, ...migrator }),
      run: runSearchMigrations,
    },
  ] as const;
}

/** Uninitialized search source; the caller initializes it so a failed startup closes it. */
export function createSearchRuntimeSource(
  endpoint: Omit<SearchDatabaseConfig, 'username' | 'password'>,
  account: Account,
) {
  return createSearchDataSource({ ...endpoint, ...account });
}

/** The projection store and the queue of its reconcile jobs (one account, one data source). */
export function searchRuntimeAdapters(source: ReturnType<typeof createSearchRuntimeSource>) {
  return { search: new TypeOrmSearchStore(source) };
}
