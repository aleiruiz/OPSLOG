import type { CreateResult, ReplaceResult, SavedViewStore } from './ports.js';
import type { SavedViewRecord } from './types.js';

const SEP = '\u0000';

/** In-memory store with the semantics of the persistent one (tests and the memory platform). */
export class InMemorySavedViewStore implements SavedViewStore {
  private readonly views = new Map<string, SavedViewRecord>();
  private readonly columnRows = new Map<string, readonly string[] | null>();

  public async list(tenantId: string, module: string, memberId: string) {
    return [...this.views.values()]
      .filter(
        (view) =>
          view.tenantId === tenantId &&
          view.module === module &&
          (view.ownerId === memberId || view.shared),
      )
      .sort((a, b) => a.nameKey.localeCompare(b.nameKey) || a.id.localeCompare(b.id))
      .map((view) => structuredClone(view));
  }

  public async get(tenantId: string, id: string) {
    const view = this.views.get(tenantId + SEP + id);
    return view ? structuredClone(view) : null;
  }

  private ownedBySameOwner(view: SavedViewRecord) {
    return [...this.views.values()].filter(
      (other) =>
        other.tenantId === view.tenantId &&
        other.ownerId === view.ownerId &&
        other.module === view.module,
    );
  }

  public async create(view: SavedViewRecord, max: number): Promise<CreateResult> {
    const own = this.ownedBySameOwner(view);
    if (own.some((other) => other.nameKey === view.nameKey)) return 'duplicate';
    if (own.length >= max) return 'limit';
    this.views.set(view.tenantId + SEP + view.id, structuredClone(view));
    return 'created';
  }

  public async replace(next: SavedViewRecord, expectedVersion: number): Promise<ReplaceResult> {
    const current = this.views.get(next.tenantId + SEP + next.id);
    if (!current || current.version !== expectedVersion) return 'stale';
    if (
      this.ownedBySameOwner(next).some(
        (other) => other.id !== next.id && other.nameKey === next.nameKey,
      )
    )
      return 'duplicate';
    this.views.set(next.tenantId + SEP + next.id, structuredClone(next));
    return 'replaced';
  }

  public async remove(tenantId: string, id: string) {
    return this.views.delete(tenantId + SEP + id);
  }

  public async getColumns(tenantId: string, memberId: string, module: string) {
    const stored = this.columnRows.get([tenantId, memberId, module].join(SEP));
    return stored ? [...stored] : null;
  }

  public async saveColumns(
    tenantId: string,
    memberId: string,
    module: string,
    columns: readonly string[] | null,
  ) {
    this.columnRows.set([tenantId, memberId, module].join(SEP), columns && [...columns]);
  }
}
