import type { MaintenanceDataSource } from '../../plans/src/data-source.js';
import type {
  Workshop,
  WorkshopStore,
} from '../../../../domain/maintenance/workshops/src/index.js';
import { MaintenanceWorkshopEntity } from '../../plans/src/entities.js';
import { appendMaintenanceAudit } from '../../plans/src/audit.js';

const toModel = (row: MaintenanceWorkshopEntity): Workshop => ({
  ...row,
  specialties: [...row.specialties],
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});
const toRow = (value: Workshop): Partial<MaintenanceWorkshopEntity> => ({
  ...value,
  specialties: [...value.specialties],
  createdAt: new Date(value.createdAt),
  updatedAt: new Date(value.updatedAt),
});

/** Persistence adapter; tenantId is required on every operation and every update predicate. */
export class TypeOrmWorkshopStore implements WorkshopStore {
  public constructor(private readonly dataSource: MaintenanceDataSource) {
    if (dataSource.options.type !== 'mysql' || dataSource.options.synchronize === true)
      throw new Error('Workshop store requires MySQL with synchronize disabled');
  }
  public async create(value: Workshop, actorId: string): Promise<void> {
    await this.dataSource.transaction('READ COMMITTED', async (manager) => {
      await manager.getRepository(MaintenanceWorkshopEntity).insert(toRow(value));
      await appendMaintenanceAudit(manager, {
        tenantId: value.tenantId,
        entityType: 'maintenance_workshop',
        entityId: value.id,
        actorId,
        action: 'maintenance.workshop.created',
        occurredAt: value.createdAt,
        revision: value.createdAt,
      });
    });
  }
  public async get(tenantId: string, id: string): Promise<Workshop | null> {
    const row = await this.dataSource
      .getRepository(MaintenanceWorkshopEntity)
      .findOneBy({ tenantId, id });
    return row ? toModel(row) : null;
  }
  public async list(tenantId: string): Promise<readonly Workshop[]> {
    return (
      await this.dataSource
        .getRepository(MaintenanceWorkshopEntity)
        .find({ where: { tenantId }, order: { name: 'ASC', id: 'ASC' } })
    ).map(toModel);
  }
  public async update(value: Workshop, actorId: string): Promise<boolean> {
    return this.dataSource.transaction('READ COMMITTED', async (manager) => {
      const { tenantId, id, name, specialties, contact, active, updatedAt } = value;
      const result = await manager
        .getRepository(MaintenanceWorkshopEntity)
        .update(
          { tenantId, id },
          { name, specialties: [...specialties], contact, active, updatedAt: new Date(updatedAt) },
        );
      if (result.affected !== 1) return false;
      await appendMaintenanceAudit(manager, {
        tenantId,
        entityType: 'maintenance_workshop',
        entityId: id,
        actorId,
        action: active ? 'maintenance.workshop.updated' : 'maintenance.workshop.deactivated',
        occurredAt: updatedAt,
        revision: updatedAt,
      });
      return true;
    });
  }
}
