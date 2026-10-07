import { EntitySchema } from 'typeorm';

/**
 * Key-like and text columns use a binary NO PAD collation: keys are compared exactly as normalized
 * by the domain, never folded again by the server.
 */
export const BINARY_COLLATION = 'utf8mb4_0900_bin';

export const SETTINGS_TABLES = {
  settings: 'opslog_company_settings',
} as const;

/**
 * Company settings row: one per company, so `tenantId` (the BRD's `company_id`) is the whole primary
 * key and no query can reach a row without naming its company. `recipientRoles` is the canonical
 * comma-joined list of role names; a CHECK keeps it well formed.
 */
export class SettingsEntity {
  tenantId!: string;
  expiryWindowDays!: number;
  recipientRoles!: string;
  version!: number;
  updatedBy!: string;
  updatedAt!: Date;
}

export const SettingsEntitySchema = new EntitySchema<SettingsEntity>({
  name: 'SettingsEntity',
  target: SettingsEntity,
  tableName: SETTINGS_TABLES.settings,
  columns: {
    tenantId: {
      name: 'company_id',
      type: 'varchar',
      length: 64,
      collation: BINARY_COLLATION,
      primary: true,
    },
    expiryWindowDays: { name: 'expiry_window_days', type: 'tinyint', unsigned: true },
    recipientRoles: {
      name: 'recipient_roles',
      type: 'varchar',
      length: 80,
      collation: BINARY_COLLATION,
    },
    version: { type: 'int', unsigned: true },
    updatedBy: { name: 'updated_by', type: 'varchar', length: 64, collation: BINARY_COLLATION },
    updatedAt: { name: 'updated_at', type: 'datetime', precision: 6 },
  },
});

export const SETTINGS_ENTITIES = [SettingsEntitySchema] as const;
