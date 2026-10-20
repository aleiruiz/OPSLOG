export interface ViewSort {
  readonly field: string;
  readonly direction: 'asc' | 'desc';
}

/** What a view holds. The keys and values are those of the list's address (`filters`). */
export interface ViewContent {
  readonly filters: Readonly<Record<string, string>>;
  readonly sort: ViewSort | null;
  /** Column keys in the order shown; `null`: the module's defaults. */
  readonly columns: readonly string[] | null;
}

export interface SavedViewRecord extends ViewContent {
  readonly id: string;
  /** Company (tenant) that owns the row. Never taken from caller input. */
  readonly tenantId: string;
  readonly ownerId: string;
  readonly module: string;
  readonly name: string;
  /** Case-folded `name`: the per-owner, per-module uniqueness key. */
  readonly nameKey: string;
  /** Visible to the whole company. */
  readonly shared: boolean;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The reader: the member of the session and what their role grants. Never taken from the request. */
export interface ViewViewer {
  readonly memberId: string;
  readonly permissions: ReadonlySet<string>;
}

/** Something a view asked for that the reader cannot use. */
export interface ViewDrop {
  readonly kind: 'filter' | 'column' | 'sort';
  readonly key: string;
  readonly label: string;
  readonly reason: 'permission' | 'invalid';
}

/** A view as one reader sees it: revalidated against the allowlist and the reader's permissions. */
export interface ViewProjection extends ViewContent {
  readonly id: string;
  readonly module: string;
  readonly name: string;
  readonly shared: boolean;
  readonly mine: boolean;
  readonly canEdit: boolean;
  readonly version: number;
  readonly dropped: readonly ViewDrop[];
  readonly updatedAt: string;
}

export interface ColumnsProjection {
  readonly module: string;
  readonly columns: readonly string[] | null;
  readonly dropped: readonly ViewDrop[];
}

export const MAX_VIEWS_PER_OWNER_AND_MODULE = 50;
export const MAX_VIEW_NAME_LENGTH = 80;
