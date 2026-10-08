import 'reflect-metadata';
import { IsNull, LessThanOrEqual, Not, type DataSource, type EntityManager } from 'typeorm';
import {
  VehicleError,
  economicNumberKey,
  isVehicleStatus,
  plateKey,
  type Vehicle,
  type VehicleConflictField,
  type VehicleFilter,
  type VehicleSlice,
  type VehicleStatusEntry,
  type VehicleStore,
  type VehicleWindow,
} from '../../../domain/vehicles/src/index.js';
import { VEHICLES_RUNTIME_ACCOUNT } from './data-source.js';
import { appendLocalAuditAndDelivery, type AuditEvent } from '../../audit/src/index.js';
import { VehicleEntity, VehicleStatusEntryEntity } from './entities.js';
import {
  VehicleStoreError,
  isDuplicateKey,
  isLockContention,
  sanitizeStoreError,
  type VehicleStoreErrorCode,
} from './errors.js';

/** Structured, PII-free report of a failed operation (operation name, coarse code, driver errno). */
export interface StoreErrorEvent {
  readonly operation: string;
  readonly code: VehicleStoreErrorCode;
  readonly errno: number | null;
}

export interface TypeOrmVehicleStoreOptions {
  /** Total attempts for a transaction that hits a deadlock or lock-wait timeout (default 3). */
  readonly maxAttempts?: number;
  readonly onError?: (event: StoreErrorEvent) => void;
}

const toVehicle = (row: VehicleEntity): Vehicle => {
  if (!isVehicleStatus(row.status)) throw new VehicleStoreError('integrity');
  return {
    id: row.id,
    tenantId: row.tenantId,
    economicNumber: row.economicNumber,
    plate: row.plate,
    vin: row.vin,
    make: row.make,
    model: row.model,
    year: row.year,
    areaId: row.areaId,
    status: row.status,
    statusReason: row.statusReason,
    odometerKm: row.odometerKm,
    registeredOn: row.registeredOn,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt === null ? null : row.archivedAt.toISOString(),
  };
};

const toEntry = (row: VehicleStatusEntryEntity): VehicleStatusEntry => {
  if (
    !isVehicleStatus(row.toStatus) ||
    (row.fromStatus !== null && !isVehicleStatus(row.fromStatus))
  )
    throw new VehicleStoreError('integrity');
  return {
    id: row.id,
    tenantId: row.tenantId,
    vehicleId: row.vehicleId,
    from: row.fromStatus,
    to: row.toStatus,
    reason: row.reason,
    actorId: row.actorId,
    version: row.version,
    at: row.at.toISOString(),
  };
};

/** Columns that can change after creation (never the tenant, the id, the registration date or `createdAt`). */
const mutableColumns = (vehicle: Vehicle) => ({
  economicNumber: vehicle.economicNumber,
  economicNumberKey: economicNumberKey(vehicle.economicNumber),
  plate: vehicle.plate,
  plateKey: plateKey(vehicle.plate),
  vin: vehicle.vin,
  make: vehicle.make,
  model: vehicle.model,
  year: vehicle.year,
  areaId: vehicle.areaId,
  status: vehicle.status,
  statusReason: vehicle.statusReason,
  odometerKm: vehicle.odometerKm,
  version: vehicle.version,
  updatedAt: new Date(vehicle.updatedAt),
  archivedAt: vehicle.archivedAt === null ? null : new Date(vehicle.archivedAt),
});

const toVehicleRow = (vehicle: Vehicle): VehicleEntity => ({
  tenantId: vehicle.tenantId,
  id: vehicle.id,
  registeredOn: vehicle.registeredOn,
  createdAt: new Date(vehicle.createdAt),
  ...mutableColumns(vehicle),
});

const toEntryRow = (entry: VehicleStatusEntry): VehicleStatusEntryEntity => ({
  tenantId: entry.tenantId,
  id: entry.id,
  vehicleId: entry.vehicleId,
  fromStatus: entry.from,
  toStatus: entry.to,
  reason: entry.reason,
  actorId: entry.actorId,
  version: entry.version,
  at: new Date(entry.at),
});

const auditEvent = (entry: VehicleStatusEntry): AuditEvent => ({
  eventId: entry.id,
  tenantId: entry.tenantId,
  action: `vehicle.status.${entry.to}`,
  entityType: 'vehicle',
  entityId: entry.vehicleId,
  occurredAt: entry.at,
  actor: { id: entry.actorId, kind: 'user' },
  correlationId: entry.id,
  data: {},
});

/**
 * Persistent TypeORM/MySQL implementation of the `VehicleStore` port.
 *
 * - Every statement names `company_id`: the primary key, every unique key and every filter start
 *   with it, so a row of another company is unreachable, not merely hidden.
 * - A vehicle change and its history row are one READ COMMITTED transaction.
 * - Concurrency is optimistic: `replace` is a single conditional UPDATE on
 *   `(company_id, id, version, odometer_km <= new)`; of two writers holding the same version,
 *   exactly one affects a row. The odometer guard is a second line of defense for BR-015.
 * - Driver errors never leave this class: duplicates become `VehicleError('duplicate', field)`,
 *   everything else the sanitized `VehicleStoreError` (no SQL, parameters, plates or VINs).
 */
export class TypeOrmVehicleStore implements VehicleStore {
  private readonly maxAttempts: number;
  private readonly onError: ((event: StoreErrorEvent) => void) | undefined;

  public constructor(
    private readonly dataSource: DataSource,
    options: TypeOrmVehicleStoreOptions = {},
  ) {
    if (dataSource.options.type !== 'mysql' || dataSource.options.synchronize === true)
      throw new Error('Vehicle store requires MySQL with synchronize disabled');
    const username = dataSource.options.username;
    if (typeof username !== 'string' || !VEHICLES_RUNTIME_ACCOUNT.test(username))
      throw new Error('Vehicle store requires its restricted runtime account');
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.onError = options.onError;
  }

  private fail(operation: string, error: unknown): Error {
    const safe = sanitizeStoreError(error);
    if (safe instanceof VehicleStoreError)
      this.onError?.({ operation, code: safe.code, errno: safe.errno });
    return safe;
  }

  /**
   * One READ COMMITTED transaction, retried only for deadlocks and lock-wait timeouts. `candidate`
   * is the vehicle being written: a duplicate-key failure is answered by naming which key it hit.
   */
  private async transaction<T>(
    operation: string,
    candidate: Vehicle | null,
    work: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.dataSource.transaction('READ COMMITTED', work);
      } catch (error) {
        if (isLockContention(error) && attempt < this.maxAttempts) continue;
        throw await this.translate(operation, candidate, error);
      }
    }
  }

  /** Statements outside a transaction (autocommit). */
  private async single<T>(operation: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw await this.translate(operation, null, error);
    }
  }

  private async translate(
    operation: string,
    candidate: Vehicle | null,
    error: unknown,
  ): Promise<Error> {
    if (candidate && isDuplicateKey(error)) {
      try {
        const field = await this.conflictField(candidate);
        return new VehicleError('duplicate', field);
      } catch (lookup) {
        return this.fail(operation, lookup);
      }
    }
    return this.fail(operation, error);
  }

  /** Names the unique key that was hit by looking the candidate up outside the failed transaction. */
  private async conflictField(candidate: Vehicle): Promise<VehicleConflictField | undefined> {
    const repository = this.dataSource.getRepository(VehicleEntity);
    const taken = async (
      where: { economicNumberKey: string } | { plateKey: string } | { vin: string },
    ) =>
      (await repository.find({ where: { tenantId: candidate.tenantId, ...where } })).some(
        (row) => row.id !== candidate.id,
      );
    if (await taken({ economicNumberKey: economicNumberKey(candidate.economicNumber) }))
      return 'economic_number';
    if (await taken({ plateKey: plateKey(candidate.plate) })) return 'plate';
    if (candidate.vin !== null && (await taken({ vin: candidate.vin }))) return 'vin';
    return undefined;
  }

  public async insert(vehicle: Vehicle, entry: VehicleStatusEntry): Promise<void> {
    await this.transaction('insert', vehicle, async (manager) => {
      await manager.getRepository(VehicleEntity).insert(toVehicleRow(vehicle));
      await manager.getRepository(VehicleStatusEntryEntity).insert(toEntryRow(entry));
      await appendLocalAuditAndDelivery(manager, auditEvent(entry));
    });
  }

  public async find(tenantId: string, id: string): Promise<Vehicle | null> {
    return this.single('find', async () => {
      const row = await this.dataSource.getRepository(VehicleEntity).findOneBy({ tenantId, id });
      return row ? toVehicle(row) : null;
    });
  }

  public async list(
    tenantId: string,
    filter: VehicleFilter,
    window: VehicleWindow,
  ): Promise<VehicleSlice> {
    return this.single('list', async () => {
      const [rows, total] = await this.dataSource.getRepository(VehicleEntity).findAndCount({
        where: {
          tenantId,
          ...(filter.status === undefined ? {} : { status: filter.status }),
          ...(filter.areaId === undefined ? {} : { areaId: filter.areaId }),
          ...(filter.includeArchived ? {} : { archivedAt: IsNull() }),
        },
        order: { economicNumberKey: 'ASC', id: 'ASC' },
        take: window.limit,
        skip: window.offset,
      });
      return { items: rows.map(toVehicle), total };
    });
  }

  public async replace(
    next: Vehicle,
    expectedVersion: number,
    entry?: VehicleStatusEntry,
  ): Promise<boolean> {
    return this.transaction('replace', next, async (manager) => {
      const result = await manager.getRepository(VehicleEntity).update(
        {
          tenantId: next.tenantId,
          id: next.id,
          version: expectedVersion,
          odometerKm: LessThanOrEqual(next.odometerKm),
        },
        mutableColumns(next),
      );
      if (result.affected !== 1) return false;
      if (entry) {
        await manager.getRepository(VehicleStatusEntryEntity).insert(toEntryRow(entry));
        await appendLocalAuditAndDelivery(manager, auditEvent(entry));
      }
      return true;
    });
  }

  public async countLiveInArea(tenantId: string, areaId: string): Promise<number> {
    return this.single('count', () =>
      this.dataSource.getRepository(VehicleEntity).countBy({
        tenantId,
        areaId,
        archivedAt: IsNull(),
        status: Not('decommissioned'),
      }),
    );
  }

  public async history(
    tenantId: string,
    vehicleId: string,
  ): Promise<readonly VehicleStatusEntry[]> {
    return this.single('history', async () =>
      (
        await this.dataSource
          .getRepository(VehicleStatusEntryEntity)
          .find({ where: { tenantId, vehicleId }, order: { version: 'ASC' } })
      ).map(toEntry),
    );
  }
}
