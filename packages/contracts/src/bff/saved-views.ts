import type { BffListModule } from './list-views.js';
import type { BffRouteDefinition } from './shared.js';

export interface BffViewSort {
  readonly field: string;
  readonly direction: 'asc' | 'desc';
}

/** What a view holds: the URL keys of its list (`BFF_LIST_CATALOG`), the order and the columns. */
export interface BffViewContent {
  /** Only keys of the module's allowlist, with values they accept. */
  readonly filters: Readonly<Record<string, string>>;
  readonly sort: BffViewSort | null;
  /** Column keys in the order shown; `null` means the module's default columns. */
  readonly columns: readonly string[] | null;
}

/** Something a view asked for that the reader cannot use; it was left out, never executed. */
export interface BffViewDrop {
  readonly kind: 'filter' | 'column' | 'sort';
  readonly key: string;
  /** Spanish name for the notice. */
  readonly label: string;
  readonly reason: 'permission' | 'invalid';
}

/**
 * A saved view as one reader sees it (FR-162). `filters`, `sort` and `columns` are already revalidated
 * against the module's allowlist and the reader's permissions; `dropped` lists what was left out.
 * The owner is not named: `mine` says whether it is the reader's own.
 */
export interface BffSavedView extends BffViewContent {
  readonly id: string;
  readonly module: BffListModule;
  readonly name: string;
  /** Visible to the whole company. */
  readonly shared: boolean;
  readonly mine: boolean;
  /** The owner, or whoever manages the company configuration, may edit or delete it. */
  readonly canEdit: boolean;
  /** Concurrency token of `PATCH`. */
  readonly version: number;
  readonly dropped: readonly BffViewDrop[];
  readonly updatedAt: string;
}

export interface BffSavedViewInput extends Partial<BffViewContent> {
  readonly module: BffListModule;
  readonly name: string;
  readonly shared?: boolean;
}

export interface BffSavedViewPatch extends Partial<BffViewContent> {
  readonly version: number;
  readonly name?: string;
  readonly shared?: boolean;
}

/** The columns a user keeps visible in one list (null: the defaults). */
export interface BffListColumns {
  readonly module: BffListModule;
  readonly columns: readonly string[] | null;
  /** Columns requested that the reader cannot use. */
  readonly dropped: readonly BffViewDrop[];
}

export interface SavedViewsRouteTypes {
  'views.list': { query: { module: BffListModule }; response: { items: readonly BffSavedView[] } };
  'views.create': { body: BffSavedViewInput; response: BffSavedView };
  'views.update': { params: { id: string }; body: BffSavedViewPatch; response: BffSavedView };
  'views.delete': { params: { id: string }; response: void };
  'views.columns': { params: { module: string }; response: BffListColumns };
  'views.columnsSave': {
    params: { module: string };
    body: { columns: readonly string[] | null };
    response: BffListColumns;
  };
}

const views = ['api', 'v1', 'views'] as const;
export const SAVED_VIEWS_ROUTES = {
  'views.list': { method: 'GET', path: [...views], kind: 'session', status: 200 },
  'views.create': { method: 'POST', path: [...views], kind: 'session-csrf', status: 201 },
  'views.update': { method: 'PATCH', path: [...views, ':id'], kind: 'session-csrf', status: 200 },
  'views.delete': { method: 'DELETE', path: [...views, ':id'], kind: 'session-csrf', status: 204 },
  'views.columns': {
    method: 'GET',
    path: [...views, 'columns', ':module'],
    kind: 'session',
    status: 200,
  },
  'views.columnsSave': {
    method: 'PUT',
    path: [...views, 'columns', ':module'],
    kind: 'session-csrf',
    status: 200,
  },
} as const satisfies Record<keyof SavedViewsRouteTypes, BffRouteDefinition>;
