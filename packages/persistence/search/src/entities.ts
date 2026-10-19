import { EntitySchema } from 'typeorm';

export const SEARCH_TABLES = { entries: 'opslog_search_entries' } as const;

export const BINARY_COLLATION = 'utf8mb4_0900_bin';
const text = (name: string, length: number, nullable = false) => ({
  name,
  type: 'varchar' as const,
  length: String(length),
  collation: BINARY_COLLATION,
  nullable,
});

export class SearchEntryEntity {
  tenantId!: string;
  entityType!: string;
  entityId!: string;
  keyKind!: string;
  normalized!: string;
  areaId!: string | null;
  display!: string;
  requiredPermission!: string;
  fingerprint!: string;
  updatedAt!: Date;
}

/**
 * One row per key of an entity. The projection is derived data: the runtime account may read,
 * write and delete it, and a rebuild recreates it from the owning modules.
 */
export const SearchEntrySchema = new EntitySchema<SearchEntryEntity>({
  name: 'SearchEntryEntity',
  target: SearchEntryEntity,
  tableName: SEARCH_TABLES.entries,
  columns: {
    tenantId: { ...text('company_id', 64), primary: true },
    entityType: { ...text('entity_type', 16), primary: true },
    entityId: { ...text('entity_id', 64), primary: true },
    keyKind: { ...text('key_kind', 24), primary: true },
    normalized: { ...text('normalized', 128), primary: true },
    areaId: text('area_id', 64, true),
    display: text('display', 200),
    requiredPermission: text('required_permission', 16),
    fingerprint: { name: 'fingerprint', type: 'char', length: '64', collation: BINARY_COLLATION },
    updatedAt: { name: 'updated_at', type: 'datetime', precision: 6 },
  },
});

export const SEARCH_ENTITIES = [SearchEntrySchema];
