import { randomUUID } from 'node:crypto';
import { SavedViewError } from './errors.js';
import type { SavedViewStore, ViewCatalog, ViewModuleCatalog } from './ports.js';
import {
  parseColumns,
  parseFilters,
  parseName,
  parseShared,
  parseSort,
  parseVersion,
  sanitize,
  sanitizeColumns,
} from './rules.js';
import {
  MAX_VIEWS_PER_OWNER_AND_MODULE,
  type ColumnsProjection,
  type SavedViewRecord,
  type ViewDrop,
  type ViewProjection,
  type ViewViewer,
} from './types.js';

export interface SavedViewServiceOptions {
  readonly now?: () => Date;
  readonly newId?: () => string;
}

/** Permission that lets a member edit or delete the shared views of others. */
const MANAGER = 'manage_config';
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,64}$/;

interface ViewInput {
  readonly name?: unknown;
  readonly shared?: unknown;
  readonly filters?: unknown;
  readonly sort?: unknown;
  readonly columns?: unknown;
}

/**
 * Saved views and visible columns (FR-162, BRD §14.3). Authentication belongs to the caller; here the
 * company and the reader come from the session, never from the input. A view of another member is
 * visible only when shared; otherwise it does not exist for the reader (404).
 */
export class SavedViewService {
  private readonly now: () => Date;
  private readonly newId: () => string;

  public constructor(
    private readonly store: SavedViewStore,
    private readonly catalog: ViewCatalog,
    options: SavedViewServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
  }

  /** The module's rules; a module without a list is a 400, a reader who cannot open the list a 403. */
  private open(moduleName: unknown, viewer: ViewViewer): ViewModuleCatalog {
    const module = typeof moduleName === 'string' ? this.catalog.module(moduleName) : null;
    if (module === null) throw new SavedViewError('invalid_input');
    if (!viewer.permissions.has(module.access)) throw new SavedViewError('forbidden');
    return module;
  }

  private project(
    module: ViewModuleCatalog,
    viewer: ViewViewer,
    view: SavedViewRecord,
  ): ViewProjection {
    const { content, dropped } = sanitize(module, viewer.permissions, view);
    const mine = view.ownerId === viewer.memberId;
    return {
      id: view.id,
      module: view.module,
      name: view.name,
      shared: view.shared,
      mine,
      canEdit: mine || (view.shared && viewer.permissions.has(MANAGER)),
      version: view.version,
      ...content,
      dropped,
      updatedAt: view.updatedAt,
    };
  }

  public async list(
    tenantId: string,
    viewer: ViewViewer,
    moduleName: unknown,
  ): Promise<readonly ViewProjection[]> {
    const module = this.open(moduleName, viewer);
    const views = await this.store.list(tenantId, moduleName as string, viewer.memberId);
    return views.map((view) => this.project(module, viewer, view));
  }

  public async create(
    tenantId: string,
    viewer: ViewViewer,
    moduleName: unknown,
    input: ViewInput,
  ): Promise<ViewProjection> {
    const module = this.open(moduleName, viewer);
    const { name, key } = parseName(input.name);
    const at = this.now().toISOString();
    const record: SavedViewRecord = {
      id: this.newId(),
      tenantId,
      ownerId: viewer.memberId,
      module: moduleName as string,
      name,
      nameKey: key,
      shared: input.shared === undefined ? false : parseShared(input.shared),
      filters: parseFilters(module, viewer.permissions, input.filters),
      sort: parseSort(module, input.sort),
      columns: parseColumns(module, viewer.permissions, input.columns),
      version: 1,
      createdAt: at,
      updatedAt: at,
    };
    const result = await this.store.create(record, MAX_VIEWS_PER_OWNER_AND_MODULE);
    if (result === 'duplicate') throw new SavedViewError('duplicate');
    if (result === 'limit') throw new SavedViewError('limit_reached');
    return this.project(module, viewer, record);
  }

  /** The view when the reader may touch it: their own, or a shared one for a manager. */
  private async editable(tenantId: string, viewer: ViewViewer, id: unknown, deleting = false) {
    if (typeof id !== 'string' || !OPAQUE_ID.test(id)) throw new SavedViewError('invalid_input');
    const view = await this.store.get(tenantId, id);
    // Someone else's private view does not exist for this reader.
    if (view === null || (view.ownerId !== viewer.memberId && !view.shared))
      throw new SavedViewError('not_found');
    // The owner may always delete their own view, even after losing the permission of the list.
    const module =
      deleting && view.ownerId === viewer.memberId
        ? (this.catalog.module(view.module) ?? this.open(view.module, viewer))
        : this.open(view.module, viewer);
    if (view.ownerId !== viewer.memberId && !viewer.permissions.has(MANAGER))
      throw new SavedViewError('forbidden');
    return { view, module };
  }

  public async update(
    tenantId: string,
    viewer: ViewViewer,
    id: unknown,
    patch: ViewInput & { readonly version?: unknown },
  ): Promise<ViewProjection> {
    const expected = parseVersion(patch.version);
    const { view, module } = await this.editable(tenantId, viewer, id);
    const named = patch.name === undefined ? null : parseName(patch.name);
    const next: SavedViewRecord = {
      ...view,
      name: named?.name ?? view.name,
      nameKey: named?.key ?? view.nameKey,
      shared: patch.shared === undefined ? view.shared : parseShared(patch.shared),
      filters:
        patch.filters === undefined
          ? view.filters
          : parseFilters(module, viewer.permissions, patch.filters),
      sort: patch.sort === undefined ? view.sort : parseSort(module, patch.sort),
      columns:
        patch.columns === undefined
          ? view.columns
          : parseColumns(module, viewer.permissions, patch.columns),
      version: expected + 1,
      updatedAt: this.now().toISOString(),
    };
    const result = await this.store.replace(next, expected);
    if (result === 'stale') throw new SavedViewError('stale_version');
    if (result === 'duplicate') throw new SavedViewError('duplicate');
    return this.project(module, viewer, next);
  }

  public async remove(tenantId: string, viewer: ViewViewer, id: unknown): Promise<void> {
    const { view } = await this.editable(tenantId, viewer, id, true);
    if (!(await this.store.remove(tenantId, view.id))) throw new SavedViewError('not_found');
  }

  /** The columns the member keeps visible; any the role no longer allows are left out and reported. */
  public async columns(
    tenantId: string,
    viewer: ViewViewer,
    moduleName: unknown,
  ): Promise<ColumnsProjection> {
    const module = this.open(moduleName, viewer);
    const dropped: ViewDrop[] = [];
    const stored = await this.store.getColumns(tenantId, viewer.memberId, moduleName as string);
    return {
      module: moduleName as string,
      columns: sanitizeColumns(module, viewer.permissions, stored, dropped),
      dropped,
    };
  }

  public async saveColumns(
    tenantId: string,
    viewer: ViewViewer,
    moduleName: unknown,
    columns: unknown,
  ): Promise<ColumnsProjection> {
    const module = this.open(moduleName, viewer);
    const parsed = parseColumns(module, viewer.permissions, columns);
    await this.store.saveColumns(
      tenantId,
      viewer.memberId,
      moduleName as string,
      parsed,
      this.now().toISOString(),
    );
    return { module: moduleName as string, columns: parsed, dropped: [] };
  }
}
