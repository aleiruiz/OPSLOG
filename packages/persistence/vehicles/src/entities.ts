import { EntitySchema } from 'typeorm';

/**
 * Key-like and text columns use a binary NO PAD collation: plates, VINs and keys are compared
 * exactly as normalized by the domain, never folded again by the server.
 */
export const BINARY_COLLATION = 'utf8mb4_0900_bin';

export const VEHICLE_TABLES = {
  vehicles: 'opslog_vehicles',
  statusHistory: 'opslog_vehicle_status_history',
} as const;

/**
 * Vehicle row. `tenantId` is the BRD's `company_id`: part of the primary key and of every
 * unique key, so no query can reach a row without naming its company.
 */
export class VehicleEntity {
  tenantId!: string;
  id!: string;
  economicNumber!: string;
  /** Case-folded uniqueness key of `economicNumber`. */
  economicNumberKey!: string;
  plate!: string;
  /** `plate` without spaces and hyphens: the uniqueness key. */
  plateKey!: string;
  vin!: string | null;
  make!: string;
  model!: string;
  year!: number;
  areaId!: string;
  status!: string;
  statusReason!: string;
  odometerKm!: number;
  registeredOn!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
  archivedAt!: Date | null;
}

export class VehicleStatusEntryEntity {
  tenantId!: string;
  id!: string;
  vehicleId!: string;
  fromStatus!: string | null;
  toStatus!: string;
  reason!: string;
  actorId!: string;
  version!: number;
  at!: Date;
}

const bin = BINARY_COLLATION;

export const VehicleEntitySchema = new EntitySchema<VehicleEntity>({
  name: 'VehicleEntity',
  target: VehicleEntity,
  tableName: VEHICLE_TABLES.vehicles,
  columns: {
    tenantId: { name: 'company_id', type: 'varchar', length: 64, collation: bin, primary: true },
    id: { type: 'varchar', length: 64, collation: bin, primary: true },
    economicNumber: { name: 'economic_number', type: 'varchar', length: 32, collation: bin },
    economicNumberKey: {
      name: 'economic_number_key',
      type: 'varchar',
      length: 32,
      collation: bin,
    },
    plate: { type: 'varchar', length: 16, collation: bin },
    plateKey: { name: 'plate_key', type: 'varchar', length: 16, collation: bin },
    vin: { type: 'char', length: 17, collation: bin, nullable: true },
    make: { type: 'varchar', length: 60, collation: bin },
    model: { type: 'varchar', length: 60, collation: bin },
    year: { type: 'smallint', unsigned: true },
    areaId: { name: 'area_id', type: 'varchar', length: 64, collation: bin },
    status: { type: 'varchar', length: 16, collation: bin },
    statusReason: { name: 'status_reason', type: 'varchar', length: 200, collation: bin },
    odometerKm: { name: 'odometer_km', type: 'int', unsigned: true },
    registeredOn: { name: 'registered_on', type: 'char', length: 10, collation: bin },
    version: { type: 'int', unsigned: true },
    createdAt: { name: 'created_at', type: 'datetime', precision: 6 },
    updatedAt: { name: 'updated_at', type: 'datetime', precision: 6 },
    archivedAt: { name: 'archived_at', type: 'datetime', precision: 6, nullable: true },
  },
  uniques: [
    { name: 'uq_vehicles_economic_number', columns: ['tenantId', 'economicNumberKey'] },
    { name: 'uq_vehicles_plate', columns: ['tenantId', 'plateKey'] },
    { name: 'uq_vehicles_vin', columns: ['tenantId', 'vin'] },
  ],
  indices: [
    { name: 'ix_vehicles_status', columns: ['tenantId', 'status'] },
    { name: 'ix_vehicles_area', columns: ['tenantId', 'areaId'] },
    { name: 'ix_vehicles_listing', columns: ['tenantId', 'economicNumberKey', 'id'] },
  ],
});

export const VehicleStatusEntryEntitySchema = new EntitySchema<VehicleStatusEntryEntity>({
  name: 'VehicleStatusEntryEntity',
  target: VehicleStatusEntryEntity,
  tableName: VEHICLE_TABLES.statusHistory,
  columns: {
    tenantId: { name: 'company_id', type: 'varchar', length: 64, collation: bin, primary: true },
    id: { type: 'varchar', length: 64, collation: bin, primary: true },
    vehicleId: { name: 'vehicle_id', type: 'varchar', length: 64, collation: bin },
    fromStatus: {
      name: 'from_status',
      type: 'varchar',
      length: 16,
      collation: bin,
      nullable: true,
    },
    toStatus: { name: 'to_status', type: 'varchar', length: 16, collation: bin },
    reason: { type: 'varchar', length: 200, collation: bin },
    actorId: { name: 'actor_id', type: 'varchar', length: 64, collation: bin },
    version: { type: 'int', unsigned: true },
    at: { type: 'datetime', precision: 6 },
  },
  uniques: [
    { name: 'uq_vehicle_status_history_version', columns: ['tenantId', 'vehicleId', 'version'] },
  ],
});

export const VEHICLE_ENTITIES = [VehicleEntitySchema, VehicleStatusEntryEntitySchema] as const;
