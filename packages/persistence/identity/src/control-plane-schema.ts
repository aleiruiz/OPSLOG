import 'reflect-metadata';
import { EntitySchema, Table, type MigrationInterface, type QueryRunner } from 'typeorm';
import { BINARY_COLLATION as bin } from './entities.js';

export const CONTROL_PLANE_TABLES = {
  tenants: 'opslog_control_tenants',
  memberships: 'opslog_control_memberships',
  sessions: 'opslog_control_sessions',
  settings: 'opslog_control_tenant_settings',
} as const;

export const CONTROL_PLANE_MIGRATION_VERSION = '2026101800010';

export interface ControlTenantRow {
  id: string;
  name: string;
  status: string;
  createdAt: Date;
}
export interface ControlMembershipRow {
  tenantId: string;
  subjectId: string;
  version: number;
  status: string;
}
export interface ControlSessionRow {
  id: string;
  tenantId: string;
  subjectId: string;
  authorizationVersion: number;
  expiresAt: Date;
  revoked: number;
}
export interface ControlSettingsRow {
  tenantId: string;
  name: string;
  mfa: string;
  sessionIdleHours: number;
}

const key = (name: string) => ({ name, type: 'varchar', length: 64, collation: bin }) as const;

export const ControlTenantRowSchema = new EntitySchema<ControlTenantRow>({
  name: 'ControlTenantRow',
  tableName: CONTROL_PLANE_TABLES.tenants,
  columns: {
    id: { ...key('id'), primary: true },
    name: { type: 'varchar', length: 160 },
    status: { type: 'varchar', length: 16, collation: bin },
    createdAt: { name: 'created_at', type: 'datetime', precision: 6 },
  },
});

export const ControlMembershipRowSchema = new EntitySchema<ControlMembershipRow>({
  name: 'ControlMembershipRow',
  tableName: CONTROL_PLANE_TABLES.memberships,
  columns: {
    tenantId: { ...key('tenant_id'), primary: true },
    subjectId: { ...key('subject_id'), primary: true },
    version: { type: 'int', unsigned: true },
    status: { type: 'varchar', length: 16, collation: bin },
  },
});

export const ControlSessionRowSchema = new EntitySchema<ControlSessionRow>({
  name: 'ControlSessionRow',
  tableName: CONTROL_PLANE_TABLES.sessions,
  columns: {
    id: { name: 'id', type: 'char', length: 64, collation: bin, primary: true },
    tenantId: key('tenant_id'),
    subjectId: key('subject_id'),
    authorizationVersion: { name: 'authorization_version', type: 'int', unsigned: true },
    expiresAt: { name: 'expires_at', type: 'datetime', precision: 6 },
    revoked: { type: 'tinyint', unsigned: true },
  },
  indices: [{ name: 'ix_control_sessions_expires', columns: ['expiresAt'] }],
});

export const ControlSettingsRowSchema = new EntitySchema<ControlSettingsRow>({
  name: 'ControlSettingsRow',
  tableName: CONTROL_PLANE_TABLES.settings,
  columns: {
    tenantId: { ...key('tenant_id'), primary: true },
    name: { type: 'varchar', length: 160 },
    mfa: { type: 'varchar', length: 16, collation: bin },
    sessionIdleHours: { name: 'session_idle_hours', type: 'tinyint', unsigned: true },
  },
});

export const CONTROL_PLANE_ENTITIES = [
  ControlTenantRowSchema,
  ControlMembershipRowSchema,
  ControlSessionRowSchema,
  ControlSettingsRowSchema,
] as const;

const T = CONTROL_PLANE_TABLES;
const column = (name: string, type: string, extra: Record<string, unknown> = {}) => ({
  name,
  type,
  ...extra,
});
const keyColumn = (name: string, extra: Record<string, unknown> = {}) =>
  column(name, 'varchar', { length: '64', collation: bin, ...extra });

/**
 * Durable control plane of a single-company deployment: the tenant, the membership projection
 * (with its version, which invalidates sessions), the mirrored sessions and the company settings.
 * It lives in the identity database and is migrated with it, by the schema owner only.
 */
export class CreateControlPlane2026101800010 implements MigrationInterface {
  name = 'CreateControlPlane2026101800010';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: T.tenants,
        columns: [
          keyColumn('id', { isPrimary: true }),
          column('name', 'varchar', { length: '160' }),
          column('status', 'varchar', { length: '16', collation: bin }),
          column('created_at', 'datetime', { precision: 6 }),
        ],
      }),
    );
    await queryRunner.createTable(
      new Table({
        name: T.memberships,
        columns: [
          keyColumn('tenant_id', { isPrimary: true }),
          keyColumn('subject_id', { isPrimary: true }),
          column('version', 'int', { unsigned: true }),
          column('status', 'varchar', { length: '16', collation: bin }),
        ],
      }),
    );
    await queryRunner.createTable(
      new Table({
        name: T.sessions,
        columns: [
          column('id', 'char', { length: '64', collation: bin, isPrimary: true }),
          keyColumn('tenant_id'),
          keyColumn('subject_id'),
          column('authorization_version', 'int', { unsigned: true }),
          column('expires_at', 'datetime', { precision: 6 }),
          column('revoked', 'tinyint', { unsigned: true }),
        ],
        indices: [{ name: 'ix_control_sessions_expires', columnNames: ['expires_at'] }],
      }),
    );
    await queryRunner.createTable(
      new Table({
        name: T.settings,
        columns: [
          keyColumn('tenant_id', { isPrimary: true }),
          column('name', 'varchar', { length: '160' }),
          column('mfa', 'varchar', { length: '16', collation: bin }),
          column('session_idle_hours', 'tinyint', { unsigned: true }),
        ],
      }),
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of [T.settings, T.sessions, T.memberships, T.tenants])
      await queryRunner.dropTable(table);
  }
}

/** Spread into the identity DataSource factories to host the control plane in the identity database. */
export const controlPlaneSchema = {
  additionalEntities: CONTROL_PLANE_ENTITIES,
  additionalMigrations: [CreateControlPlane2026101800010],
} as const;
