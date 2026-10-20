import {
  employeeProjection,
  incidentProjection,
  policyProjection,
  vehicleProjection,
} from './entries.js';
import { entityKey, type SearchSources, type SearchStore, type SourcePage } from './ports.js';
import type { EntityProjection, EntityRef } from './types.js';

const PAGE = 100;
const CHUNK = 200;

export interface ReconcileSummary {
  readonly written: number;
  readonly removed: number;
  readonly unchanged: number;
}

async function eachPage<T>(
  read: (offset: number, limit: number) => Promise<SourcePage<T>>,
  visit: (item: T) => void,
): Promise<void> {
  for (let offset = 0; ; offset += PAGE) {
    const page = await read(offset, PAGE);
    for (const item of page.items) visit(item);
    if (page.items.length === 0 || offset + PAGE >= page.total) return;
  }
}

/**
 * Keeps the projection of one company equal to what the owning modules hold now. It reads their
 * ports (never their tables) and writes only the entities whose fingerprint changed, so repeating
 * a run, or running the full rebuild, leaves the same rows: it is idempotent.
 */
export class SearchIndexer {
  public constructor(
    private readonly store: SearchStore,
    private readonly sources: SearchSources,
  ) {}

  private async desired(tenantId: string): Promise<Map<string, EntityProjection>> {
    const wanted = new Map<string, EntityProjection>();
    const keep = (projection: EntityProjection | null) => {
      if (projection && projection.entries.length > 0)
        wanted.set(entityKey(projection.entityType, projection.entityId), projection);
    };
    await eachPage(
      (o, l) => this.sources.vehicles(tenantId, o, l),
      (v) => keep(vehicleProjection(tenantId, v)),
    );
    await eachPage(
      (o, l) => this.sources.employees(tenantId, o, l),
      (e) => keep(employeeProjection(tenantId, e)),
    );
    await eachPage(
      (o, l) => this.sources.incidents(tenantId, o, l),
      (i) => keep(incidentProjection(tenantId, i)),
    );
    await eachPage(
      (o, l) => this.sources.policies(tenantId, o, l),
      (p) => keep(policyProjection(tenantId, p)),
    );
    return wanted;
  }

  /** Brings the company's rows to the current state; `full` rewrites every entity, changed or not. */
  public async reconcile(
    tenantId: string,
    options: { readonly full?: boolean } = {},
  ): Promise<ReconcileSummary> {
    const wanted = await this.desired(tenantId);
    const stored = await this.store.fingerprints(tenantId);
    const upserts = [...wanted].filter(
      ([key, projection]) => options.full === true || stored.get(key) !== projection.fingerprint,
    );
    const removals: EntityRef[] = [...stored.keys()]
      .filter((key) => !wanted.has(key))
      .map((key) => {
        const at = key.indexOf(':');
        return { entityType: key.slice(0, at), entityId: key.slice(at + 1) } as EntityRef;
      });
    for (let at = 0; at < Math.max(upserts.length, removals.length); at += CHUNK)
      await this.store.apply(tenantId, {
        upserts: upserts.slice(at, at + CHUNK).map(([, projection]) => projection),
        removals: removals.slice(at, at + CHUNK),
      });
    return {
      written: upserts.length,
      removed: removals.length,
      unchanged: wanted.size - upserts.length,
    };
  }

  /** Full rebuild of one company, for the first deployment and after a restore. */
  public rebuild(tenantId: string): Promise<ReconcileSummary> {
    return this.reconcile(tenantId, { full: true });
  }
}
