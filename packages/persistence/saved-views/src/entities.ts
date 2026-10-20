import { EntitySchema } from 'typeorm';

export const SAVED_VIEW_TABLES = {
  views: 'opslog_saved_views',
  columns: 'opslog_list_columns',
} as const;

export const BINARY_COLLATION = 'utf8mb4_0900_bin';
const text = (name: string, length: number, nullable = false) => ({
  name,
  type: 'varchar' as const,
  length: String(length),
  collation: BINARY_COLLATION,
  nullable,
});

export class SavedViewEntity {
  tenantId!: string;
  id!: string;
  ownerId!: string;
  module!: string;
  name!: string;
  nameKey!: string;
  filters!: string;
  sortField!: string | null;
  sortDirection!: string | null;
  columns!: string | null;
  shared!: boolean;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export class ListColumnsEntity {
  tenantId!: string;
  memberId!: string;
  module!: string;
  columns!: string | null;
  updatedAt!: Date;
}

/** A saved view of one list. `filters` and `columns` are JSON text validated by the domain before they get here. */
export const SavedViewSchema = new EntitySchema<SavedViewEntity>({
  name: 'SavedViewEntity',
  target: SavedViewEntity,
  tableName: SAVED_VIEW_TABLES.views,
  columns: {
    tenantId: { ...text('company_id', 64), primary: true },
    id: { ...text('id', 64), primary: true },
    ownerId: text('owner_id', 64),
    module: text('module', 24),
    name: text('name', 80),
    nameKey: text('name_key', 240),
    filters: { name: 'filters', type: 'text', collation: BINARY_COLLATION },
    sortField: text('sort_field', 32, true),
    sortDirection: text('sort_direction', 4, true),
    columns: { name: 'columns', type: 'text', collation: BINARY_COLLATION, nullable: true },
    shared: { name: 'shared', type: 'tinyint', transformer: boolTransformer() },
    version: { name: 'version', type: 'int', unsigned: true },
    createdAt: { name: 'created_at', type: 'datetime', precision: 6 },
    updatedAt: { name: 'updated_at', type: 'datetime', precision: 6 },
  },
});

/** The columns a member keeps visible in one list. */
export const ListColumnsSchema = new EntitySchema<ListColumnsEntity>({
  name: 'ListColumnsEntity',
  target: ListColumnsEntity,
  tableName: SAVED_VIEW_TABLES.columns,
  columns: {
    tenantId: { ...text('company_id', 64), primary: true },
    memberId: { ...text('member_id', 64), primary: true },
    module: { ...text('module', 24), primary: true },
    columns: { name: 'columns', type: 'text', collation: BINARY_COLLATION, nullable: true },
    updatedAt: { name: 'updated_at', type: 'datetime', precision: 6 },
  },
});

function boolTransformer() {
  return { to: (value: boolean) => (value ? 1 : 0), from: (value: number) => value === 1 };
}

export const SAVED_VIEW_ENTITIES = [SavedViewSchema, ListColumnsSchema];
