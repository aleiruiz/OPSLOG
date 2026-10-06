import {
  MigrationInterface,
  QueryRunner,
  Table,
  TableForeignKey,
  TableIndex,
  TableUnique,
  type TableColumnOptions,
} from 'typeorm';
import { BINARY_COLLATION, IDENTITY_TABLES } from './entities.js';

export const IDENTITY_MIGRATION_VERSION = '2026100600010';
export const IDENTITY_MIGRATIONS_TABLE = 'opslog_identity_migrations';

const text = (name: string, length: number, extra: Partial<TableColumnOptions> = {}) =>
  ({
    name,
    type: 'varchar',
    length: String(length),
    collation: BINARY_COLLATION,
    ...extra,
  }) satisfies TableColumnOptions;
const hash = (name: string): TableColumnOptions => ({
  name,
  type: 'char',
  length: '64',
  collation: BINARY_COLLATION,
});
const moment = (name: string, nullable = false): TableColumnOptions => ({
  name,
  type: 'datetime',
  precision: 6,
  isNullable: nullable,
});
const version = (name: string): TableColumnOptions => ({
  name,
  type: 'int',
  unsigned: true,
});

const T = IDENTITY_TABLES;
const STATUSES = "'pending','active','revoked'";

/** CHECK constraints (enforced by MySQL >= 8.0.16). TypeORM's MySQL runner cannot emit them, so they are raw DDL. */
export const IDENTITY_CHECKS: readonly {
  readonly table: string;
  readonly name: string;
  readonly expression: string;
}[] = [
  {
    table: T.identities,
    name: 'ck_identity_identities_status',
    expression: `\`status\` IN (${STATUSES})`,
  },
  {
    table: T.identities,
    name: 'ck_identity_identities_mfa',
    expression: "`mfa` IN ('disabled','optional','required')",
  },
  {
    table: T.identities,
    name: 'ck_identity_identities_version',
    expression: '`authorization_version` >= 1',
  },
  {
    table: T.external,
    name: 'ck_identity_external_status',
    expression: `\`status\` IN (${STATUSES})`,
  },
  {
    table: T.memberships,
    name: 'ck_identity_memberships_status',
    expression: `\`status\` IN (${STATUSES})`,
  },
  {
    table: T.memberships,
    name: 'ck_identity_memberships_role',
    expression: "`role` REGEXP '^[a-z][a-z0-9_]{0,31}$'",
  },
  {
    table: T.memberships,
    name: 'ck_identity_memberships_activated',
    expression: "`status` <> 'active' OR `activated_at` IS NOT NULL",
  },
  {
    table: T.recoveries,
    name: 'ck_identity_recoveries_window',
    expression: '`expires_at` > `issued_at`',
  },
  {
    table: T.sessions,
    name: 'ck_identity_sessions_window',
    expression: '`expires_at` > `created_at`',
  },
  {
    table: T.sessions,
    name: 'ck_identity_sessions_version',
    expression: '`authorization_version` >= 1',
  },
];

const foreignKey = (
  name: string,
  columnNames: string[],
  referencedTableName: string,
  referencedColumnNames: string[],
) => new TableForeignKey({ name, columnNames, referencedTableName, referencedColumnNames });

export class CreateIdentityStore2026100600010 implements MigrationInterface {
  name = 'CreateIdentityStore2026100600010';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: T.identities,
        columns: [
          text('id', 64, { isPrimary: true }),
          text('status', 16),
          text('mfa', 16),
          version('authorization_version'),
          moment('created_at'),
        ],
      }),
    );
    await queryRunner.createTable(
      new Table({
        name: T.external,
        columns: [
          text('id', 64, { isPrimary: true }),
          text('provider', 200),
          text('subject', 200),
          text('identity_id', 64),
          text('status', 16),
          moment('created_at'),
        ],
        uniques: [
          new TableUnique({
            name: 'uq_identity_external_subject',
            columnNames: ['provider', 'subject'],
          }),
          new TableUnique({ name: 'uq_identity_external_identity', columnNames: ['identity_id'] }),
        ],
        foreignKeys: [
          foreignKey('fk_identity_external_identity', ['identity_id'], T.identities, ['id']),
        ],
      }),
    );
    await queryRunner.createTable(
      new Table({
        name: T.memberships,
        columns: [
          text('tenant_id', 64, { isPrimary: true }),
          text('identity_id', 64, { isPrimary: true }),
          text('id', 64),
          text('role', 32),
          text('status', 16),
          moment('created_at'),
          moment('activated_at', true),
        ],
        uniques: [new TableUnique({ name: 'uq_identity_memberships_id', columnNames: ['id'] })],
        indices: [
          new TableIndex({
            name: 'ix_identity_memberships_identity',
            columnNames: ['identity_id'],
          }),
          new TableIndex({
            name: 'ix_identity_memberships_role',
            columnNames: ['tenant_id', 'role', 'status'],
          }),
        ],
        foreignKeys: [
          foreignKey('fk_identity_memberships_identity', ['identity_id'], T.identities, ['id']),
        ],
      }),
    );
    // Invitations and sessions reference the tenant-scoped membership key, never the bare identity.
    await queryRunner.createTable(
      new Table({
        name: T.invitations,
        columns: [
          text('id', 64, { isPrimary: true }),
          text('tenant_id', 64),
          text('identity_id', 64),
          hash('token_hash'),
          moment('expires_at'),
          moment('consumed_at', true),
        ],
        uniques: [
          new TableUnique({ name: 'uq_identity_invitations_token', columnNames: ['token_hash'] }),
        ],
        indices: [
          new TableIndex({
            name: 'ix_identity_invitations_member',
            columnNames: ['tenant_id', 'identity_id', 'consumed_at'],
          }),
        ],
        foreignKeys: [
          foreignKey(
            'fk_identity_invitations_member',
            ['tenant_id', 'identity_id'],
            T.memberships,
            ['tenant_id', 'identity_id'],
          ),
        ],
      }),
    );
    await queryRunner.createTable(
      new Table({
        name: T.recoveries,
        columns: [
          text('id', 64, { isPrimary: true }),
          text('identity_id', 64),
          hash('token_hash'),
          moment('issued_at'),
          moment('expires_at'),
          moment('used_at', true),
          moment('superseded_at', true),
        ],
        uniques: [
          new TableUnique({ name: 'uq_identity_recoveries_token', columnNames: ['token_hash'] }),
        ],
        indices: [
          new TableIndex({
            name: 'ix_identity_recoveries_identity',
            columnNames: ['identity_id', 'used_at'],
          }),
        ],
        foreignKeys: [
          foreignKey('fk_identity_recoveries_identity', ['identity_id'], T.identities, ['id']),
        ],
      }),
    );
    await queryRunner.createTable(
      new Table({
        name: T.sessions,
        columns: [
          text('id', 64, { isPrimary: true }),
          text('identity_id', 64),
          text('tenant_id', 64),
          hash('token_hash'),
          moment('created_at'),
          moment('last_seen_at'),
          moment('expires_at'),
          moment('revoked_at', true),
          version('authorization_version'),
        ],
        uniques: [
          new TableUnique({ name: 'uq_identity_sessions_token', columnNames: ['token_hash'] }),
        ],
        indices: [
          new TableIndex({
            name: 'ix_identity_sessions_member',
            columnNames: ['tenant_id', 'identity_id', 'revoked_at'],
          }),
          new TableIndex({ name: 'ix_identity_sessions_expires', columnNames: ['expires_at'] }),
        ],
        foreignKeys: [
          foreignKey('fk_identity_sessions_member', ['tenant_id', 'identity_id'], T.memberships, [
            'tenant_id',
            'identity_id',
          ]),
        ],
      }),
    );
    await queryRunner.createTable(
      new Table({
        name: T.tenantLocks,
        columns: [text('tenant_id', 64, { isPrimary: true }), moment('created_at')],
      }),
    );
    for (const check of IDENTITY_CHECKS)
      await queryRunner.query(
        `ALTER TABLE \`${check.table}\` ADD CONSTRAINT \`${check.name}\` CHECK (${check.expression})`,
      );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable(T.tenantLocks);
    await queryRunner.dropTable(T.sessions);
    await queryRunner.dropTable(T.recoveries);
    await queryRunner.dropTable(T.invitations);
    await queryRunner.dropTable(T.memberships);
    await queryRunner.dropTable(T.external);
    await queryRunner.dropTable(T.identities);
  }
}
