import type { ISODateTime, Page } from '../index.js';
import type { BffRouteDefinition } from './shared.js';

/** An area of the company's organizational tree (up to four levels). The company is implicit. */
export interface BffArea {
  readonly id: string;
  readonly name: string;
  readonly code: string | null;
  /** `null` for a root area. */
  readonly parentId: string | null;
  /** Level in the tree: 1 for a root, at most 4. */
  readonly depth: number;
  readonly active: boolean;
  /**
   * Responsible users as raw identity subjects (no `user-` prefix, unlike `BffAreaHistoryEntry.actorId`),
   * sorted. Names and emails never reach the browser.
   */
  readonly responsibleIds: readonly string[];
  readonly version: number;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
  readonly deactivatedAt: ISODateTime | null;
}

/** The single-area read adds the active resources that block its deactivation. */
export interface BffAreaDetail extends BffArea {
  readonly resourceCounts: { readonly vehicles: number; readonly people: number };
}

export interface BffAreaInput {
  readonly name: string;
  readonly code?: string | null;
  readonly parentId?: string | null;
  readonly responsibleIds?: readonly string[];
}

/** Fields that can be edited in place; at least one besides `version`. `parentId` moves the whole subtree. */
export interface BffAreaPatch {
  readonly version: number;
  readonly name?: string;
  readonly code?: string | null;
  readonly parentId?: string | null;
  readonly responsibleIds?: readonly string[];
}

export interface BffAreasQuery {
  readonly limit?: 25 | 50 | 100;
  readonly cursor?: string;
  /** An area id for its direct children, `root` for the roots; omitted for every level. */
  readonly parentId?: string;
  /** `true` to include deactivated areas (default: hidden). */
  readonly includeInactive?: 'true' | 'false';
}

export const BFF_AREA_ACTIONS = ['created', 'updated', 'activated', 'deactivated'] as const;
export type BffAreaAction = (typeof BFF_AREA_ACTIONS)[number];
export const BFF_AREA_FIELDS = ['name', 'code', 'parent', 'responsibles'] as const;
export type BffAreaField = (typeof BFF_AREA_FIELDS)[number];

/**
 * Who changed what and when. Field names only: no names, codes or responsible ids. `actorId` is the
 * acting user's id with the `user-` prefix (`user-<subject>`); `BffArea.responsibleIds` are the raw
 * identity subjects without that prefix.
 */
export interface BffAreaHistoryEntry {
  readonly id: string;
  readonly action: BffAreaAction;
  readonly fields: readonly BffAreaField[];
  readonly fromParentId: string | null;
  readonly toParentId: string | null;
  readonly actorId: string;
  readonly version: number;
  readonly at: ISODateTime;
}

export interface BffAreaHistoryQuery {
  readonly limit?: 25 | 50 | 100;
  readonly cursor?: string;
}

/** Request and response types of the areas routes. */
export interface AreasRouteTypes {
  'areas.list': { query?: BffAreasQuery; response: Page<BffArea> };
  'areas.create': { body: BffAreaInput; response: BffArea };
  'areas.get': { params: { id: string }; response: BffAreaDetail };
  'areas.update': { params: { id: string }; body: BffAreaPatch; response: BffArea };
  'areas.deactivate': { params: { id: string }; body: { version: number }; response: BffArea };
  'areas.activate': { params: { id: string }; body: { version: number }; response: BffArea };
  'areas.history': {
    params: { id: string };
    query?: BffAreaHistoryQuery;
    response: Page<BffAreaHistoryEntry>;
  };
}

export const AREAS_ROUTES = {
  'areas.list': { method: 'GET', path: ['api', 'areas'], kind: 'session', status: 200 },
  'areas.create': {
    method: 'POST',
    path: ['api', 'areas'],
    kind: 'session-csrf',
    status: 201,
  },
  'areas.get': { method: 'GET', path: ['api', 'areas', ':id'], kind: 'session', status: 200 },
  'areas.update': {
    method: 'PUT',
    path: ['api', 'areas', ':id'],
    kind: 'session-csrf',
    status: 200,
  },
  'areas.deactivate': {
    method: 'POST',
    path: ['api', 'areas', ':id', 'deactivate'],
    kind: 'session-csrf',
    status: 200,
  },
  'areas.activate': {
    method: 'POST',
    path: ['api', 'areas', ':id', 'activate'],
    kind: 'session-csrf',
    status: 200,
  },
  'areas.history': {
    method: 'GET',
    path: ['api', 'areas', ':id', 'history'],
    kind: 'session',
    status: 200,
  },
} as const satisfies Record<keyof AreasRouteTypes, BffRouteDefinition>;
