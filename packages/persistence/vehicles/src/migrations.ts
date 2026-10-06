import {
  MigrationInterface,
  QueryRunner,
  Table,
  TableForeignKey,
  TableIndex,
  TableUnique,
  type TableColumnOptions,
} from 'typeorm';
import { BINARY_COLLATION, VEHICLE_TABLES } from './entities.js';

export const VEHICLES_MIGRATION_VERSION = '2026100600030';
export const VEHICLES_MIGRATIONS_TABLE = 'opslog_vehicles_migrations';

const text = (name: string, length: number, extra: Partial<TableColumnOptions> = {}) =>
  ({
    name,
    type: 'varchar',
    length: String(length),
    collation: BINARY_COLLATION,
    ...extra,
  }) satisfies TableColumnOptions;
const fixed = (name: string, length: number, extra: Partial<TableColumnOptions> = {}) =>
  ({
    name,
    type: 'char',
    length: String(length),
    collation: BINARY_COLLATION,
    ...extra,
  }) satisfies TableColumnOptions;
const moment = (name: string, nullable = false): TableColumnOptions => ({
  name,
  type: 'datetime',
  precision: 6,
  isNullable: nullable,
});
const counter = (name: string): TableColumnOptions => ({ name, type: 'int', unsigned: true });

const T = VEHICLE_TABLES;
const STATUSES =
  "'active','restricted','in_maintenance','out_of_service','inactive','decommissioned'";

/** CHECK constraints (MySQL >= 8.0.16 enforces them). TypeORM's MySQL runner cannot emit them, so they are raw DDL. */
export const VEHICLE_CHECKS: readonly {
  readonly table: string;
  readonly name: string;
  readonly expression: string;
}[] = [
  {
    table: T.vehicles,
    name: 'ck_vehicles_status',
    expression: `\`status\` IN (${STATUSES})`,
  },
  {
    table: T.vehicles,
    name: 'ck_vehicles_odometer',
    expression: '`odometer_km` <= 9999999',
  },
  {
    table: T.vehicles,
    name: 'ck_vehicles_year',
    expression: '`year` BETWEEN 1950 AND 2200',
  },
  {
    table: T.vehicles,
    name: 'ck_vehicles_version',
    expression: '`version` >= 1',
  },
  {
    table: T.vehicles,
    name: 'ck_vehicles_keys',
    expression:
      'CHAR_LENGTH(`economic_number_key`) > 0 AND CHAR_LENGTH(`plate_key`) > 0 AND CHAR_LENGTH(TRIM(`economic_number`)) > 0 AND CHAR_LENGTH(TRIM(`plate`)) > 0',
  },
  {
    table: T.vehicles,
    name: 'ck_vehicles_vin',
    expression: "`vin` IS NULL OR `vin` REGEXP '^[A-HJ-NPR-Z0-9]{17}$'",
  },
  {
    table: T.vehicles,
    name: 'ck_vehicles_registered_on',
    expression: "`registered_on` REGEXP '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'",
  },
  {
    table: T.vehicles,
    name: 'ck_vehicles_reason',
    expression: 'CHAR_LENGTH(TRIM(`status_reason`)) > 0',
  },
  {
    table: T.statusHistory,
    name: 'ck_vehicle_status_history_to',
    expression: `\`to_status\` IN (${STATUSES})`,
  },
  {
    table: T.statusHistory,
    name: 'ck_vehicle_status_history_from',
    expression: `\`from_status\` IS NULL OR \`from_status\` IN (${STATUSES})`,
  },
  {
    table: T.statusHistory,
    name: 'ck_vehicle_status_history_version',
    expression: '`version` >= 1 AND CHAR_LENGTH(TRIM(`reason`)) > 0',
  },
];

/**
 * Vehicles and their status history. Every row carries `company_id`; the history references the
 * composite `(company_id, id)` key of its vehicle, so a history row can never attach to a vehicle
 * of another company. Economic number, plate and VIN are unique per company (BR-010).
 */
export class CreateVehicles2026100600030 implements MigrationInterface {
  name = 'CreateVehicles2026100600030';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: T.vehicles,
        columns: [
          text('company_id', 64, { isPrimary: true }),
          text('id', 64, { isPrimary: true }),
          text('economic_number', 32),
          text('economic_number_key', 32),
          text('plate', 16),
          text('plate_key', 16),
          fixed('vin', 17, { isNullable: true }),
          text('make', 60),
          text('model', 60),
          { name: 'year', type: 'smallint', unsigned: true },
          text('area_id', 64),
          text('status', 16),
          text('status_reason', 200),
          counter('odometer_km'),
          fixed('registered_on', 10),
          counter('version'),
          moment('created_at'),
          moment('updated_at'),
          moment('archived_at', true),
        ],
        uniques: [
          new TableUnique({
            name: 'uq_vehicles_economic_number',
            columnNames: ['company_id', 'economic_number_key'],
          }),
          new TableUnique({ name: 'uq_vehicles_plate', columnNames: ['company_id', 'plate_key'] }),
          new TableUnique({ name: 'uq_vehicles_vin', columnNames: ['company_id', 'vin'] }),
        ],
        indices: [
          new TableIndex({ name: 'ix_vehicles_status', columnNames: ['company_id', 'status'] }),
          new TableIndex({ name: 'ix_vehicles_area', columnNames: ['company_id', 'area_id'] }),
          new TableIndex({
            name: 'ix_vehicles_listing',
            columnNames: ['company_id', 'economic_number_key', 'id'],
          }),
        ],
      }),
    );
    await queryRunner.createTable(
      new Table({
        name: T.statusHistory,
        columns: [
          text('company_id', 64, { isPrimary: true }),
          text('id', 64, { isPrimary: true }),
          text('vehicle_id', 64),
          text('from_status', 16, { isNullable: true }),
          text('to_status', 16),
          text('reason', 200),
          text('actor_id', 64),
          counter('version'),
          moment('at'),
        ],
        uniques: [
          new TableUnique({
            name: 'uq_vehicle_status_history_version',
            columnNames: ['company_id', 'vehicle_id', 'version'],
          }),
        ],
        foreignKeys: [
          new TableForeignKey({
            name: 'fk_vehicle_status_history_vehicle',
            columnNames: ['company_id', 'vehicle_id'],
            referencedTableName: T.vehicles,
            referencedColumnNames: ['company_id', 'id'],
          }),
        ],
      }),
    );
    for (const check of VEHICLE_CHECKS)
      await queryRunner.query(
        `ALTER TABLE \`${check.table}\` ADD CONSTRAINT \`${check.name}\` CHECK (${check.expression})`,
      );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable(T.statusHistory);
    await queryRunner.dropTable(T.vehicles);
  }
}
