import type { Area, AreaHistoryEntry, AreaNode } from './types.js';

export interface AreaFilter {
  /** `undefined`: every level; `null`: roots only; an id: the direct children of that area. */
  readonly parentId?: string | null;
  readonly includeInactive: boolean;
}
export interface AreaWindow {
  readonly limit: number;
  readonly offset: number;
}
export interface AreaSlice {
  readonly items: readonly Area[];
  /** Number of areas matching the filter, not only the window. */
  readonly total: number;
}
export interface AreaHistorySlice {
  readonly items: readonly AreaHistoryEntry[];
  readonly total: number;
}

/**
 * Reads and writes inside one tenant-serialized transaction. Every method is tenant-scoped: an
 * area of another tenant is simply absent.
 */
export interface AreaTx {
  find(id: string): Promise<Area | null>;
  /** Direct children (any status) of an area, or the roots when `parentId` is null. */
  children(parentId: string | null): Promise<readonly AreaNode[]>;
  /**
   * Inserts the area (with its responsibles) and its history row. Throws
   * `AreaError('duplicate', 'name' | 'code')` when a sibling name or a code is already taken.
   */
  insert(area: Area, entry: AreaHistoryEntry): Promise<void>;
  /**
   * Conditional write: replaces the area (and its responsibles) and appends the history row only
   * while the stored version is `expectedVersion`; false otherwise. Duplicates throw as `insert`.
   */
  replace(next: Area, expectedVersion: number, entry: AreaHistoryEntry): Promise<boolean>;
  /** Rewrites the depth of a descendant after its subtree moved (no version change, no history). */
  setDepth(id: string, depth: number): Promise<void>;
}

/**
 * Persistence port. `transaction` serializes every hierarchy-changing use case of one tenant (a
 * cycle or a fifth level can be created by two concurrent writes that are each valid alone), so
 * the invariants are checked and written under one tenant lock. Reads outside a transaction see
 * committed state.
 */
export interface AreaStore {
  transaction<T>(tenantId: string, work: (tx: AreaTx) => Promise<T>): Promise<T>;
  find(tenantId: string, id: string): Promise<Area | null>;
  /** Ordered by name (case-insensitive), then id. */
  list(tenantId: string, filter: AreaFilter, window: AreaWindow): Promise<AreaSlice>;
  /** Newest change first (by version, descending). */
  history(tenantId: string, areaId: string, window: AreaWindow): Promise<AreaHistorySlice>;
}

/** BR-021 count port: how many active resources of one kind sit in an area. */
export interface AreaResourceCounter {
  countActive(tenantId: string, areaId: string): Promise<number>;
}
export type AreaResource = 'vehicles' | 'people';
export type AreaResourceCounters = Readonly<Record<AreaResource, AreaResourceCounter>>;
export const AREA_RESOURCES: readonly AreaResource[] = ['vehicles', 'people'];

/** Placeholder for people until the employees module exists: no person is ever assigned. */
export const NO_RESOURCES: AreaResourceCounter = { countActive: async () => 0 };

/**
 * Port to the tenant's membership directory (FR-041): responsible users must be active members.
 * Without it the service stores opaque ids unchecked.
 */
export interface AreaMemberDirectory {
  isActiveMember(tenantId: string, userId: string): Promise<boolean>;
}
