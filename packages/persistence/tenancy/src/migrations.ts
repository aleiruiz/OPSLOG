import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

export const CONTROL_PLANE_MIGRATION_VERSION = '2026100400010';
export const TENANT_DATABASE_MIGRATION_VERSION = '2026100400020';

export class CreateTenancyControlPlane2026100400010 implements MigrationInterface {
  name = 'CreateTenancyControlPlane2026100400010';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'opslog_control_tenants',
        columns: [
          { name: 'id', type: 'char', length: '36', isPrimary: true },
          { name: 'name', type: 'varchar', length: '160' },
          { name: 'status', type: 'varchar', length: '24' },
          { name: 'created_at', type: 'datetime', precision: 6 },
        ],
      }),
    );
    await queryRunner.createTable(
      new Table({
        name: 'opslog_control_tenant_locations',
        columns: [
          { name: 'tenant_id', type: 'char', length: '36', isPrimary: true },
          { name: 'database_name', type: 'varchar', length: '128', isUnique: true },
          { name: 'credential_ref', type: 'varchar', length: '255', isUnique: true },
          { name: 'secret_version', type: 'int', unsigned: true, default: 1 },
          { name: 'migration_version', type: 'varchar', length: '64', isNullable: true },
          { name: 'runtime_role_verified', type: 'boolean', default: false },
          { name: 'isolation_probe_verified', type: 'boolean', default: false },
          { name: 'verified_at', type: 'datetime', precision: 6, isNullable: true },
        ],
        foreignKeys: [
          new TableForeignKey({
            columnNames: ['tenant_id'],
            referencedTableName: 'opslog_control_tenants',
            referencedColumnNames: ['id'],
          }),
        ],
      }),
    );
    await queryRunner.createTable(
      new Table({
        name: 'opslog_control_memberships',
        columns: [
          { name: 'tenant_id', type: 'char', length: '36', isPrimary: true },
          { name: 'subject_id', type: 'varchar', length: '255', isPrimary: true },
          { name: 'status', type: 'varchar', length: '24' },
          { name: 'version', type: 'int', unsigned: true },
        ],
        foreignKeys: [
          new TableForeignKey({
            columnNames: ['tenant_id'],
            referencedTableName: 'opslog_control_tenants',
            referencedColumnNames: ['id'],
          }),
        ],
      }),
    );
    await queryRunner.createTable(
      new Table({
        name: 'opslog_control_sessions',
        columns: [
          { name: 'session_id_hash', type: 'char', length: '64', isPrimary: true },
          { name: 'tenant_id', type: 'char', length: '36' },
          { name: 'subject_id', type: 'varchar', length: '255' },
          { name: 'authorization_version', type: 'int', unsigned: true },
          { name: 'expires_at', type: 'datetime', precision: 6 },
          { name: 'revoked', type: 'boolean', default: false },
        ],
        foreignKeys: [
          new TableForeignKey({
            columnNames: ['tenant_id'],
            referencedTableName: 'opslog_control_tenants',
            referencedColumnNames: ['id'],
          }),
        ],
      }),
    );
    await queryRunner.createTable(
      new Table({
        name: 'opslog_control_provisioning_jobs',
        columns: [
          { name: 'id', type: 'char', length: '36', isUnique: true },
          { name: 'idempotency_key', type: 'varchar', length: '255', isPrimary: true },
          { name: 'tenant_id', type: 'char', length: '36', isUnique: true },
          { name: 'payload_hash', type: 'char', length: '64' },
          { name: 'status', type: 'varchar', length: '24' },
          { name: 'attempt', type: 'int', unsigned: true, default: 0 },
          { name: 'lease_owner', type: 'char', length: '36', isNullable: true },
          { name: 'lease_expires_at', type: 'datetime', precision: 6, isNullable: true },
          { name: 'error_code', type: 'varchar', length: '64', isNullable: true },
          { name: 'created_at', type: 'datetime', precision: 6 },
          { name: 'updated_at', type: 'datetime', precision: 6 },
        ],
        indices: [
          new TableIndex({
            name: 'ix_provisioning_status_lease',
            columnNames: ['status', 'lease_expires_at'],
          }),
        ],
        foreignKeys: [
          new TableForeignKey({
            columnNames: ['tenant_id'],
            referencedTableName: 'opslog_control_tenants',
            referencedColumnNames: ['id'],
          }),
        ],
      }),
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('opslog_control_provisioning_jobs');
    await queryRunner.dropTable('opslog_control_sessions');
    await queryRunner.dropTable('opslog_control_memberships');
    await queryRunner.dropTable('opslog_control_tenant_locations');
    await queryRunner.dropTable('opslog_control_tenants');
  }
}

export class CreateTenantDatabase2026100400020 implements MigrationInterface {
  name = 'CreateTenantDatabase2026100400020';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'opslog_tenant_records',
        columns: [
          { name: 'id', type: 'char', length: '36', isPrimary: true },
          { name: 'tenant_id', type: 'char', length: '36' },
          { name: 'value', type: 'varchar', length: '255' },
          { name: 'version', type: 'int', unsigned: true, default: 1 },
        ],
        indices: [
          new TableIndex({
            name: 'uq_tenant_record_tenant_id',
            columnNames: ['tenant_id', 'id'],
            isUnique: true,
          }),
        ],
      }),
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('opslog_tenant_records');
  }
}
