import {
  chunksOf,
  type Incident,
  type IncidentBatchReads,
  type IncidentStore,
  type IncidentTransition,
} from '../../../../../packages/domain/incidents/cases/src/index.js';
import type {
  IncidentRepairStore,
  RepairBatchReads,
  RepairLink,
} from '../../../../../packages/domain/incidents/repairs/src/index.js';

/**
 * Batch reads for the reports. Stores that have the batch methods answer in a bounded number of
 * reads (chunked `IN` lists in MySQL); a store without them is read one id at a time, so the
 * answer is the same either way.
 */

/** The cases that exist for `ids`, once each. */
export async function casesOf(
  store: Pick<IncidentStore, 'get'>,
  tenantId: string,
  ids: readonly string[],
): Promise<readonly Incident[]> {
  if (ids.length === 0) return [];
  const batch = store as Partial<IncidentBatchReads>;
  if (typeof batch.getMany === 'function') return batch.getMany(tenantId, ids);
  const found = await Promise.all([...new Set(ids)].map((id) => store.get(tenantId, id)));
  return found.filter((incident): incident is Incident => incident !== null);
}

/** The timeline of each case, oldest first; a case without entries gets an empty list. */
export async function historiesOf(
  store: Pick<IncidentStore, 'history'>,
  tenantId: string,
  ids: readonly string[],
): Promise<ReadonlyMap<string, readonly IncidentTransition[]>> {
  if (ids.length === 0) return new Map();
  const batch = store as Partial<IncidentBatchReads>;
  if (typeof batch.historyMany === 'function') return batch.historyMany(tenantId, ids);
  const result = new Map<string, readonly IncidentTransition[]>();
  for (const id of new Set(ids)) result.set(id, await store.history(tenantId, id));
  return result;
}

/** The link of each order that has one, by order id. */
export async function linksOfOrders(
  store: Pick<IncidentRepairStore, 'linkOfOrder'>,
  tenantId: string,
  orderIds: readonly string[],
): Promise<ReadonlyMap<string, RepairLink>> {
  if (orderIds.length === 0) return new Map();
  const batch = store as Partial<RepairBatchReads>;
  if (typeof batch.linksOfOrders === 'function') {
    const result = new Map<string, RepairLink>();
    for (const chunk of chunksOf(orderIds))
      for (const [id, link] of await batch.linksOfOrders(tenantId, chunk)) result.set(id, link);
    return result;
  }
  const result = new Map<string, RepairLink>();
  for (const id of new Set(orderIds)) {
    const link = await store.linkOfOrder(tenantId, id);
    if (link) result.set(id, link);
  }
  return result;
}
