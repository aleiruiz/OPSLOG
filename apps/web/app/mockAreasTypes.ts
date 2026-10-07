import type { Area, AreasPort } from './types';

/**
 * In-memory areas with the semantics of the real backend (`packages/domain/areas`): a tree of at most four
 * levels, optimistic versions (409 `stale_version`), read-only inactive areas (409 `immutable`), sibling-name and
 * company-wide code uniqueness (409 `duplicate` with the colliding field), 409 `area_in_use` when deactivating an
 * area with active sub-areas, vehicles or people, 422 `invalid_hierarchy` (cycle, depth, inactive or unknown
 * parent), 422 `invalid_responsible`, a history without names and a uniform 400/404. Permissions are enforced by the
 * caller (`mockApi`).
 */
export interface MockAreaStore {
  readonly port: AreasPort;
  /** Another actor renames the area on the server: its version moves on, so a form that loaded it is stale. */
  changeExternally(id: string, change: Partial<Pick<Area, 'name'>>): void;
  /** Another actor deactivates the area on the server (no rule checks: a test control). */
  deactivateExternally(id: string): void;
  /** Adds to the active people the personnel module reports for the area (a test control). */
  setPeople(id: string, people: number): void;
  snapshot(): readonly Area[];
}

export interface MockAreaEnvironment {
  /** Active vehicles of an area (the fleet decides). */
  readonly liveVehicles: (areaId: string) => number;
  /** Active people of an area (the personnel module decides). Adds to the count set with `setPeople`. */
  readonly livePeople?: (areaId: string) => number;
  /** Whether the user is an active member of the company. */
  readonly isMember: (userId: string) => boolean;
  /** The signed-in user, recorded in the history. */
  readonly actorId: () => string;
}
