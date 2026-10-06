import { EntitySchema } from 'typeorm';

/**
 * Key-like and text columns use a binary NO PAD collation: names and codes are compared exactly
 * as normalized by the domain, never folded again by the server.
 */
export const BINARY_COLLATION = 'utf8mb4_0900_bin';

export const AREA_TABLES = {
  areas: 'opslog_areas',
  responsibles: 'opslog_area_responsibles',
  history: 'opslog_area_history',
  locks: 'opslog_area_locks',
} as const;

/**
 * Area row. `tenantId` is the BRD's `company_id`: part of the primary key and of every unique
 * key, so no query can reach a row without naming its company.
 */
export class AreaEntity {
  tenantId!: string;
  id!: string;
  name!: string;
  /** Case-folded uniqueness key of `name` among siblings. */
  nameKey!: string;
  code!: string | null;
  parentId!: string | null;
  /** `parentId`, or the empty string for a root: lets the sibling-name key include roots (NULLs never collide). */
  parentKey!: string;
  depth!: number;
  active!: boolean;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
  deactivatedAt!: Date | null;
}

export class AreaResponsibleEntity {
  tenantId!: string;
  areaId!: string;
  userId!: string;
}

export class AreaHistoryEntity {
  tenantId!: string;
  id!: string;
  areaId!: string;
  version!: number;
  action!: string;
  /** Comma-separated field names (a fixed vocabulary), empty when none. */
  changedFields!: string;
  fromParentId!: string | null;
  toParentId!: string | null;
  actorId!: string;
  at!: Date;
}

/** One row per company: the row the tree transactions lock to serialize hierarchy changes. */
export class AreaLockEntity {
  tenantId!: string;
}

const bin = BINARY_COLLATION;
const tenantColumn = {
  name: 'company_id',
  type: 'varchar',
  length: 64,
  collation: bin,
  primary: true,
} as const;

export const AreaEntitySchema = new EntitySchema<AreaEntity>({
  name: 'AreaEntity',
  target: AreaEntity,
  tableName: AREA_TABLES.areas,
  columns: {
    tenantId: tenantColumn,
    id: { type: 'varchar', length: 64, collation: bin, primary: true },
    name: { type: 'varchar', length: 80, collation: bin },
    nameKey: { name: 'name_key', type: 'varchar', length: 160, collation: bin },
    code: { type: 'varchar', length: 32, collation: bin, nullable: true },
    parentId: {
      name: 'parent_id',
      type: 'varchar',
      length: 64,
      collation: bin,
      nullable: true,
    },
    parentKey: { name: 'parent_key', type: 'varchar', length: 64, collation: bin },
    depth: { type: 'tinyint', unsigned: true },
    active: { type: 'boolean' },
    version: { type: 'int', unsigned: true },
    createdAt: { name: 'created_at', type: 'datetime', precision: 6 },
    updatedAt: { name: 'updated_at', type: 'datetime', precision: 6 },
    deactivatedAt: { name: 'deactivated_at', type: 'datetime', precision: 6, nullable: true },
  },
  uniques: [
    { name: 'uq_areas_sibling_name', columns: ['tenantId', 'parentKey', 'nameKey'] },
    { name: 'uq_areas_code', columns: ['tenantId', 'code'] },
  ],
  indices: [
    { name: 'ix_areas_parent', columns: ['tenantId', 'parentId'] },
    { name: 'ix_areas_listing', columns: ['tenantId', 'nameKey', 'id'] },
  ],
});

export const AreaResponsibleEntitySchema = new EntitySchema<AreaResponsibleEntity>({
  name: 'AreaResponsibleEntity',
  target: AreaResponsibleEntity,
  tableName: AREA_TABLES.responsibles,
  columns: {
    tenantId: tenantColumn,
    areaId: { name: 'area_id', type: 'varchar', length: 64, collation: bin, primary: true },
    userId: { name: 'user_id', type: 'varchar', length: 64, collation: bin, primary: true },
  },
  indices: [{ name: 'ix_area_responsibles_user', columns: ['tenantId', 'userId'] }],
});

export const AreaHistoryEntitySchema = new EntitySchema<AreaHistoryEntity>({
  name: 'AreaHistoryEntity',
  target: AreaHistoryEntity,
  tableName: AREA_TABLES.history,
  columns: {
    tenantId: tenantColumn,
    id: { type: 'varchar', length: 64, collation: bin, primary: true },
    areaId: { name: 'area_id', type: 'varchar', length: 64, collation: bin },
    version: { type: 'int', unsigned: true },
    action: { type: 'varchar', length: 16, collation: bin },
    changedFields: { name: 'changed_fields', type: 'varchar', length: 48, collation: bin },
    fromParentId: {
      name: 'from_parent_id',
      type: 'varchar',
      length: 64,
      collation: bin,
      nullable: true,
    },
    toParentId: {
      name: 'to_parent_id',
      type: 'varchar',
      length: 64,
      collation: bin,
      nullable: true,
    },
    actorId: { name: 'actor_id', type: 'varchar', length: 64, collation: bin },
    at: { type: 'datetime', precision: 6 },
  },
  uniques: [{ name: 'uq_area_history_version', columns: ['tenantId', 'areaId', 'version'] }],
});

export const AreaLockEntitySchema = new EntitySchema<AreaLockEntity>({
  name: 'AreaLockEntity',
  target: AreaLockEntity,
  tableName: AREA_TABLES.locks,
  columns: { tenantId: tenantColumn },
});

export const AREA_ENTITIES = [
  AreaEntitySchema,
  AreaResponsibleEntitySchema,
  AreaHistoryEntitySchema,
  AreaLockEntitySchema,
] as const;
