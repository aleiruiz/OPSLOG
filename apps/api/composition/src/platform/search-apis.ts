import { createHash } from 'node:crypto';
import {
  EmployeeError,
  PII_FIELD_LABEL,
  licenseNumberKey,
  nationalIdKey,
  normalizeLicenseNumber,
  normalizeNationalId,
} from '../../../../../packages/domain/employees/src/index.js';
import type { IncidentStore } from '../../../../../packages/domain/incidents/cases/src/index.js';
import {
  InMemorySearchStore,
  SEARCH_EVENT_ACTOR,
  SEARCH_RECONCILE_EVENT,
  SearchIndexer,
  SearchService,
  type ReconcileJob,
  type ReconcileQueue,
  type SearchSources,
  type SearchStore,
} from '../../../../../packages/domain/search/src/index.js';
import { InMemoryMechanicStore } from '../../../../../packages/domain/maintenance/mechanics/src/index.js';
import type { PiiCipher } from '../../../../../packages/platform/pii/src/index.js';
import { SearchApi } from '../../../search/src/index.js';
import type { PlatformKernel } from './kernel.js';
import type { IncidentServices } from './incident-apis.js';
import { createMechanicScope } from './mechanic-scope.js';
import type { PlatformAdapters } from './types.js';

/** Codes of the identification types a company can register (the same catalog the screens offer). */
const IDENTIFICATION_TYPES = ['ine', 'curp', 'rfc', 'passport'] as const;
/** Reconcile jobs of one company queued within this window are the same job. */
const JOB_WINDOW_MS = 60_000;

export type SearchAdapter = SearchStore & ReconcileQueue;

export interface SearchModule {
  readonly api: SearchApi;
  readonly service: SearchService;
  /** The projection writer the worker runs; `rebuild` is the full rebuild of one company. */
  readonly indexer: SearchIndexer;
  readonly store: SearchAdapter;
  /** Queues a reconcile job for the company in its outbox. */
  readonly enqueueReconcile: (tenantId: string, full?: boolean) => Promise<void>;
}

/**
 * Reads of the owning modules through their services and ports, as a system actor of one company.
 * Nothing here reads a table of another module.
 */
export function searchSources(services: IncidentServices, incidents: IncidentStore): SearchSources {
  return {
    vehicles: async (tenantId, offset, limit) => {
      const page = await services.vehicles.list(tenantId, { limit, offset });
      return { total: page.total, items: page.items };
    },
    employees: async (tenantId, offset, limit) => {
      const page = await services.employees.list(tenantId, { limit, offset });
      return {
        total: page.total,
        items: page.items.map((e) => ({
          id: e.id,
          kind: e.kind,
          areaId: e.areaId,
          firstName: e.firstName,
          lastName: e.lastName,
          employeeNumber: e.employeeNumber,
          // The blind indexes already stored with the sealed fields; the values stay sealed.
          nationalIdIndex: e.pii.nationalId?.index ?? null,
          licenseIndex: e.pii.licenseNumber?.index ?? null,
          archivedAt: e.archivedAt,
          updatedAt: e.updatedAt,
        })),
      };
    },
    incidents: async (tenantId, offset, limit) => {
      const page = await incidents.list(tenantId, {
        filter: {},
        sort: 'createdAt',
        direction: 'asc',
        limit: limit as 100,
        offset,
      });
      return {
        total: page.total,
        items: page.items.map((i) => ({
          id: i.id,
          areaId: i.areaId,
          folio: i.folio,
          claimNumber: i.claimNumber,
          updatedAt: i.updatedAt,
        })),
      };
    },
    policies: async (tenantId, offset, limit) => {
      const page = await services.policies.list(
        tenantId,
        { includeArchived: false },
        { limit, offset },
      );
      return {
        total: page.total,
        items: page.items.map((p) => ({
          id: p.id,
          policyNumber: p.policyNumber,
          insurer: p.insurer,
          archivedAt: p.archivedAt,
          updatedAt: p.updatedAt,
        })),
      };
    },
  };
}

/**
 * Blind indexes of what was typed as a license or an identification. A value that is not shaped
 * like either, or a cipher that fails, yields none: the search then simply finds nothing exact.
 */
export function exactKeysOf(pii: PiiCipher) {
  const attempt = async (work: () => Promise<string>): Promise<string[]> => {
    try {
      return [await work()];
    } catch {
      return [];
    }
  };
  return async (tenantId: string, raw: string): Promise<readonly string[]> => {
    const keys: string[] = [];
    try {
      const license = licenseNumberKey(normalizeLicenseNumber(raw));
      keys.push(
        ...(await attempt(() => pii.blindIndex(tenantId, PII_FIELD_LABEL.licenseNumber, license))),
      );
    } catch (error) {
      if (!(error instanceof EmployeeError)) throw error;
    }
    try {
      const value = normalizeNationalId(raw);
      for (const idType of IDENTIFICATION_TYPES)
        keys.push(
          ...(await attempt(() =>
            pii.blindIndex(tenantId, PII_FIELD_LABEL.nationalId, nationalIdKey(idType, value)),
          )),
        );
    } catch (error) {
      if (!(error instanceof EmployeeError)) throw error;
    }
    return keys;
  };
}

/** Where reconcile jobs go without a durable store: the in-memory outbox of the platform. */
function memoryQueue(kernel: PlatformKernel): ReconcileQueue {
  return {
    enqueueReconcile: async (job: ReconcileJob) => {
      await kernel.outbox.transaction((tx) => {
        const eventId = `search-${job.jobId}`;
        tx.enqueue({
          eventId,
          tenantId: job.tenantId,
          type: SEARCH_RECONCILE_EVENT,
          payload: job.full === true ? { full: true } : {},
          occurredAt: job.at,
          idempotencyKey: eventId,
          actorRef: { subject: SEARCH_EVENT_ACTOR, kind: 'system' },
          entityId: job.tenantId,
          schemaVersion: 1,
        });
      });
    },
  };
}

/**
 * Global search over the projection. The projection is memory unless a persistent store is injected;
 * the worker keeps it equal to the modules by consuming `search.reconcile` events.
 */
export function buildSearch(
  kernel: PlatformKernel,
  adapters: PlatformAdapters,
  services: IncidentServices,
  incidents: IncidentStore,
  pii: PiiCipher,
): SearchModule {
  const store: SearchAdapter =
    adapters.search ?? Object.assign(new InMemorySearchStore(), memoryQueue(kernel));
  const service = new SearchService(store, exactKeysOf(pii));
  const scope = createMechanicScope(adapters.maintenanceMechanics ?? new InMemoryMechanicStore());
  return {
    api: new SearchApi({
      authorize: async (token, correlationId) => {
        const context = await kernel.authorize(token, correlationId, []);
        return {
          tenantId: context.tenantId,
          subject: context.actor.subject,
          permissions: await kernel.access.resolvePermissions(context),
        };
      },
      mechanicLinked: scope.mechanicLinked,
      service,
    }),
    service,
    indexer: new SearchIndexer(store, searchSources(services, incidents)),
    store,
    enqueueReconcile: (tenantId, full) => {
      const now = kernel.now();
      const window = Math.floor(now.getTime() / JOB_WINDOW_MS);
      const digest = createHash('sha256').update(tenantId).digest('hex').slice(0, 24);
      return store.enqueueReconcile({
        tenantId,
        jobId: `${full === true ? 'full' : 'inc'}-${digest}-${window}`,
        at: now.toISOString(),
        ...(full === true ? { full: true } : {}),
      });
    },
  };
}
