import 'reflect-metadata';
import { type DataSource, type EntityManager } from 'typeorm';
import type {
  IncidentApplyResult,
  IncidentMutation,
  IncidentStore,
} from '../../../../domain/incidents/cases/src/index.js';
import type {
  IncidentRepairStore,
  RepairChange,
  RepairLink,
} from '../../../../domain/incidents/repairs/src/index.js';
import { IncidentRepairLinkSchema, type IncidentRepairLinkEntity } from './entities.js';

const rowOf = (link: RepairLink): IncidentRepairLinkEntity => ({
  tenantId: link.tenantId,
  incidentId: link.incidentId,
  id: link.id,
  orderId: link.orderId,
  linkedAt: new Date(link.linkedAt),
  linkedBy: link.linkedBy,
});
export const linkFrom = (row: IncidentRepairLinkEntity): RepairLink => ({
  id: row.id,
  tenantId: row.tenantId,
  incidentId: row.incidentId,
  orderId: row.orderId,
  linkedAt: row.linkedAt.toISOString(),
  linkedBy: row.linkedBy,
});
export const linkRow = rowOf;

/**
 * Links of the cases. Every selector carries the tenant. Writes join the transaction of the incident
 * store, so the case row, its timeline, audit, outbox and the link commit or fail together.
 */
export class TypeOrmIncidentRepairStore implements IncidentRepairStore {
  public constructor(
    private readonly dataSource: DataSource,
    private readonly base: IncidentStore,
  ) {
    if (dataSource.options.type !== 'mysql' || dataSource.options.synchronize === true)
      throw new Error('Incident repair store requires MySQL with synchronize disabled');
  }

  public async links(
    tenantId: string,
    incidentId: string,
    tx?: unknown,
  ): Promise<readonly RepairLink[]> {
    const source = (tx as EntityManager | undefined) ?? this.dataSource;
    const rows = await source
      .getRepository(IncidentRepairLinkSchema)
      .find({ where: { tenantId, incidentId }, order: { linkedAt: 'ASC', id: 'ASC' } });
    return rows.map(linkFrom);
  }

  public async linkOfOrder(tenantId: string, orderId: string): Promise<RepairLink | null> {
    const row = await this.dataSource
      .getRepository(IncidentRepairLinkSchema)
      .findOneBy({ tenantId, orderId });
    return row ? linkFrom(row) : null;
  }

  private async write(manager: EntityManager, change: RepairChange): Promise<boolean> {
    const repository = manager.getRepository(IncidentRepairLinkSchema);
    if (change.kind === 'link') {
      // A second link of the same order trips the unique key (ER_DUP_ENTRY) and rolls everything back.
      await repository.insert(rowOf(change.link));
      return true;
    }
    const removed = await repository.delete({
      tenantId: change.tenantId,
      incidentId: change.incidentId,
      id: change.linkId,
    });
    return removed.affected === 1;
  }

  public apply(mutation: IncidentMutation, change: RepairChange): Promise<IncidentApplyResult> {
    return this.base.apply(mutation, { run: (tx) => this.write(tx as EntityManager, change) });
  }
}
