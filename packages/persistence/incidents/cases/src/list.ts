import type { Repository } from 'typeorm';
import type {
  IncidentListQuery,
  IncidentPage,
} from '../../../../domain/incidents/cases/src/index.js';
import type { IncidentEntity } from './entities.js';
import { incidentFrom } from './mapping.js';

// Same order as the domain's SEVERITY_RANK; a draft without severity sorts below `low`.
const SEVERITY_RANK =
  "CASE i.severity WHEN 'low' THEN 1 WHEN 'medium' THEN 2 WHEN 'high' THEN 3 WHEN 'critical' THEN 4 ELSE 0 END";
const SORT_COLUMN = {
  occurredAt: 'i.occurredAt',
  createdAt: 'i.createdAt',
  folio: 'i.folio',
} as const;

/** Tenant-scoped list with filters, an allowlisted sort and a stable tiebreak by id. */
export async function listPage(
  repository: Repository<IncidentEntity>,
  tenantId: string,
  query: IncidentListQuery,
): Promise<IncidentPage> {
  const { filter } = query;
  const base = () => {
    const builder = repository
      .createQueryBuilder('i')
      .where('i.tenantId = :tenantId', { tenantId });
    if (filter.statuses)
      builder.andWhere('i.status IN (:...statuses)', { statuses: filter.statuses });
    if (filter.severity) builder.andWhere('i.severity = :severity', { severity: filter.severity });
    if (filter.type) builder.andWhere('i.type = :type', { type: filter.type });
    if (filter.vehicleId)
      builder.andWhere('i.vehicleId = :vehicleId', { vehicleId: filter.vehicleId });
    if (filter.responsibleId)
      builder.andWhere('i.responsibleId = :responsibleId', { responsibleId: filter.responsibleId });
    if (filter.createdBy)
      builder.andWhere('i.createdBy = :createdBy', { createdBy: filter.createdBy });
    if (filter.occurredFrom)
      builder.andWhere('i.occurredOn >= :from', { from: filter.occurredFrom });
    if (filter.occurredTo) builder.andWhere('i.occurredOn <= :to', { to: filter.occurredTo });
    return builder;
  };
  const direction = query.direction === 'asc' ? 'ASC' : 'DESC';
  const ordered = base();
  if (query.sort === 'severity') ordered.orderBy(SEVERITY_RANK, direction);
  else ordered.orderBy(SORT_COLUMN[query.sort], direction);
  const [rows, total] = await Promise.all([
    ordered.addOrderBy('i.id', direction).offset(query.offset).limit(query.limit).getMany(),
    base().getCount(),
  ]);
  return { items: rows.map(incidentFrom), total };
}
