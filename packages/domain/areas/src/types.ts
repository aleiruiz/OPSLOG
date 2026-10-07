export const MAX_AREA_DEPTH = 4;
export const MAX_RESPONSIBLES = 20;
export const MAX_NAME_LENGTH = 80;
export const MAX_CODE_LENGTH = 32;
export const MAX_LIST_LIMIT = 100;
export const DEFAULT_LIST_LIMIT = 25;

export interface Area {
  readonly id: string;
  /** Company (tenant) that owns the row. Never taken from caller input. */
  readonly tenantId: string;
  readonly name: string;
  /** Optional short code, upper case; unique per company. */
  readonly code: string | null;
  readonly parentId: string | null;
  /** Level in the tree: 1 for a root, at most `MAX_AREA_DEPTH`. */
  readonly depth: number;
  /** BRD `activa`. Deactivation is the soft delete of BR-009: rows are never removed. */
  readonly active: boolean;
  /**
   * Responsible users (FR-041): raw identity subjects (without the `user-` prefix that
   * `AreaHistoryEntry.actorId` carries), sorted, no duplicates.
   */
  readonly responsibleIds: readonly string[];
  /** Optimistic concurrency token: starts at 1, +1 on every change. */
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deactivatedAt: string | null;
}

/** What the tree traversals need of a row. */
export type AreaNode = Pick<Area, 'id' | 'depth' | 'active'>;

export const AREA_ACTIONS = ['created', 'updated', 'activated', 'deactivated'] as const;
export type AreaAction = (typeof AREA_ACTIONS)[number];
export const AREA_FIELDS = ['name', 'code', 'parent', 'responsibles'] as const;
export type AreaField = (typeof AREA_FIELDS)[number];

export const isAreaAction = (value: unknown): value is AreaAction =>
  typeof value === 'string' && (AREA_ACTIONS as readonly string[]).includes(value);
export const isAreaField = (value: unknown): value is AreaField =>
  typeof value === 'string' && (AREA_FIELDS as readonly string[]).includes(value);

/**
 * One row of the area history (BRD §7.2.3: changes are recorded). Who, when and what changed, by
 * field name only: no names, codes or responsible ids. `actorId` is the acting user's id
 * (`user-<subject>`), the one pseudonymous identifier a row carries. A parent change also records
 * the two parent ids (opaque area ids).
 */
export interface AreaHistoryEntry {
  readonly id: string;
  readonly tenantId: string;
  readonly areaId: string;
  readonly action: AreaAction;
  readonly fields: readonly AreaField[];
  readonly fromParentId: string | null;
  readonly toParentId: string | null;
  readonly actorId: string;
  /** Version the area had right after this change: orders the history, unique per area. */
  readonly version: number;
  readonly at: string;
}
