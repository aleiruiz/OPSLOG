export {
  createAreasDataSource,
  createAreasMigrationDataSource,
  runAreasMigrations,
  AREAS_RUNTIME_ACCOUNT,
  type AreasDatabaseConfig,
} from './data-source.js';
export {
  AREA_ENTITIES,
  AREA_TABLES,
  BINARY_COLLATION,
  AreaEntity,
  AreaHistoryEntity,
  AreaLockEntity,
  AreaResponsibleEntity,
} from './entities.js';
export { AreaStoreError, type AreaStoreErrorCode } from './errors.js';
export {
  CreateAreas2026100600040,
  AREAS_MIGRATIONS_TABLE,
  AREAS_MIGRATION_VERSION,
  AREA_CHECKS,
} from './migrations.js';
export { TypeOrmAreaStore, type StoreErrorEvent, type TypeOrmAreaStoreOptions } from './store.js';
