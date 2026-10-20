import type { Handler } from '../../base/src/index.js';
import {
  SEARCH_RECONCILE_EVENT,
  parseReconcilePayload,
  type SearchIndexer,
} from '../../../../packages/domain/search/src/index.js';

/**
 * Registers the search projection consumer on the shared durable outbox worker. The company always
 * comes from the claimed envelope; a payload that names one, or anything else unexpected, is refused
 * and the outbox retries it and then dead-letters it. Running a job twice leaves the same rows.
 */
export function registerSearchHandlers(
  worker: { register(type: string, handler: Handler): void },
  search: Pick<SearchIndexer, 'reconcile'>,
): void {
  worker.register(SEARCH_RECONCILE_EVENT, async (payload, event) => {
    const { full } = parseReconcilePayload(payload);
    await search.reconcile(event.tenantId, { full });
  });
}
