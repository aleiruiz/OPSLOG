import type { MaintenanceDataSource } from '../../plans/src/data-source.js';
import type {
  Mechanic,
  MechanicStore,
} from '../../../../domain/maintenance/mechanics/src/index.js';
import { MaintenanceMechanicEntity } from '../../plans/src/entities.js';
import { appendMaintenanceAudit } from '../../plans/src/audit.js';

const toModel = (row: MaintenanceMechanicEntity): Mechanic => ({
  ...row,
  kind: row.kind as Mechanic['kind'],
  specialties: [...row.specialties],
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});
const toRow = (value: Mechanic): Partial<MaintenanceMechanicEntity> => ({
  ...value,
  specialties: [...value.specialties],
  createdAt: new Date(value.createdAt),
  updatedAt: new Date(value.updatedAt),
});

/** Tenant predicates are mandatory. Internal membership validity is enforced by the injected membership gate. */
export class TypeOrmMechanicStore implements MechanicStore {
  public constructor(private readonly dataSource: MaintenanceDataSource) {
    if (dataSource.options.type !== 'mysql' || dataSource.options.synchronize === true)
      throw new Error('Mechanic store requires MySQL with synchronize disabled');
  }
  public async create(value: Mechanic, actorId: string): Promise<void> {
    await this.dataSource.transaction('READ COMMITTED', async (manager) => {
      await manager.getRepository(MaintenanceMechanicEntity).insert(toRow(value));
      await appendMaintenanceAudit(manager, {
        tenantId: value.tenantId,
        entityType: 'maintenance_mechanic',
        entityId: value.id,
        actorId,
        action: 'maintenance.mechanic.created',
        occurredAt: value.createdAt,
        revision: value.createdAt,
      });
    });
  }
  public async get(tenantId: string, id: string): Promise<Mechanic | null> {
    const row = await this.dataSource
      .getRepository(MaintenanceMechanicEntity)
      .findOneBy({ tenantId, id });
    return row ? toModel(row) : null;
  }
  public async list(tenantId: string): Promise<readonly Mechanic[]> {
    return (
      await this.dataSource
        .getRepository(MaintenanceMechanicEntity)
        .find({ where: { tenantId }, order: { name: 'ASC', id: 'ASC' } })
    ).map(toModel);
  }
  public async update(value: Mechanic, actorId: string): Promise<boolean> {
    return this.dataSource.transaction('READ COMMITTED', async (manager) => {
      const { tenantId, id, name, specialties, contact, workshopId, active, updatedAt } = value;
      const result = await manager.getRepository(MaintenanceMechanicEntity).update(
        { tenantId, id },
        {
          name,
          specialties: [...specialties],
          contact,
          workshopId,
          active,
          updatedAt: new Date(updatedAt),
        },
      );
      if (result.affected !== 1) return false;
      await appendMaintenanceAudit(manager, {
        tenantId,
        entityType: 'maintenance_mechanic',
        entityId: id,
        actorId,
        action: active ? 'maintenance.mechanic.updated' : 'maintenance.mechanic.deactivated',
        occurredAt: updatedAt,
        revision: updatedAt,
      });
      return true;
    });
  }
}
