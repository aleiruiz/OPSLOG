export {
  createDocumentsDataSource,
  createDocumentsMigrationDataSource,
  runDocumentsMigrations,
  DOCUMENTS_RUNTIME_ACCOUNT,
  type DocumentsDatabaseConfig,
} from './data-source.js';
export {
  BINARY_COLLATION,
  DOCUMENT_ENTITIES,
  DOCUMENT_TABLES,
  DocumentEntity,
  DocumentRevisionEntity,
} from './entities.js';
export { DocumentStoreError, type DocumentStoreErrorCode } from './errors.js';
export {
  CreateDocuments2026100600060,
  DOCUMENTS_MIGRATIONS_TABLE,
  DOCUMENTS_MIGRATION_VERSION,
  DOCUMENT_CHECKS,
} from './migrations.js';
export {
  TypeOrmDocumentStore,
  type StoreErrorEvent,
  type TypeOrmDocumentStoreOptions,
} from './store.js';
