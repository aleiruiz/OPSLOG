import type { EmployeeFacts, IncidentFacts, PolicyFacts, VehicleFacts } from './entries.js';
import type {
  EntityProjection,
  EntityRef,
  SearchEntityType,
  SearchStoreGroup,
  SearchStoreQuery,
} from './types.js';

/** The projection store. Every method names the company; a row of another company is absent. */
export interface SearchStore {
  /** Fingerprint of each entity that has rows, keyed by `entityKey`. */
  fingerprints(tenantId: string): Promise<ReadonlyMap<string, string>>;
  /** Rewrites the rows of each given entity and removes the rows of each removed one, atomically. */
  apply(
    tenantId: string,
    changes: {
      readonly upserts: readonly EntityProjection[];
      readonly removals: readonly EntityRef[];
    },
  ): Promise<void>;
  /** At most `query.limit` hits per type, with the total of matching entities. */
  search(query: SearchStoreQuery): Promise<readonly SearchStoreGroup[]>;
}

export const entityKey = (entityType: SearchEntityType, entityId: string): string =>
  `${entityType}:${entityId}`;

/** A page of entities of one kind, read through the port of the module that owns them. */
export interface SourcePage<T> {
  readonly items: readonly T[];
  readonly total: number;
}

/** Reads of the owning modules, as the projection needs them (system actor, one company). */
export interface SearchSources {
  vehicles(tenantId: string, offset: number, limit: number): Promise<SourcePage<VehicleFacts>>;
  employees(tenantId: string, offset: number, limit: number): Promise<SourcePage<EmployeeFacts>>;
  incidents(tenantId: string, offset: number, limit: number): Promise<SourcePage<IncidentFacts>>;
  policies(tenantId: string, offset: number, limit: number): Promise<SourcePage<PolicyFacts>>;
}
