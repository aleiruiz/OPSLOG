import type { Area } from '../app/types';
import { MAX_AREA_DEPTH } from './rules';

/** An area with its direct children, ordered by name like the server's listing. */
export interface AreaNode {
  readonly area: Area;
  readonly children: readonly AreaNode[];
}

const byName = (a: Area, b: Area) =>
  a.name.toLowerCase().localeCompare(b.name.toLowerCase(), 'es') || a.id.localeCompare(b.id);

/** Builds the forest. An area whose parent is not in the list (filtered out) is shown as a root. */
export function buildTree(areas: readonly Area[]): readonly AreaNode[] {
  const ids = new Set(areas.map((area) => area.id));
  const children = new Map<string | null, Area[]>();
  for (const area of areas) {
    const key = area.parentId !== null && ids.has(area.parentId) ? area.parentId : null;
    children.set(key, [...(children.get(key) ?? []), area]);
  }
  const make = (area: Area): AreaNode => ({
    area,
    children: (children.get(area.id) ?? []).sort(byName).map(make),
  });
  return (children.get(null) ?? []).sort(byName).map(make);
}

/** Ids of the areas that are visible given which nodes are expanded, in display (depth-first) order. */
export function visibleIds(roots: readonly AreaNode[], expanded: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const walk = (nodes: readonly AreaNode[]) => {
    for (const node of nodes) {
      out.push(node.area.id);
      if (expanded.has(node.area.id)) walk(node.children);
    }
  };
  walk(roots);
  return out;
}

export function allNodes(roots: readonly AreaNode[]): AreaNode[] {
  return roots.flatMap((node) => [node, ...allNodes(node.children)]);
}

export function findNode(roots: readonly AreaNode[], id: string): AreaNode | null {
  return allNodes(roots).find((node) => node.area.id === id) ?? null;
}

/** Ids of the nodes below `node` (any depth, any status). */
export const descendantIds = (node: AreaNode): string[] =>
  allNodes(node.children).map((child) => child.area.id);

/** Levels of the subtree rooted at `node`, counting the node itself (a leaf is 1). */
export const subtreeHeight = (node: AreaNode): number =>
  1 + node.children.reduce((deepest, child) => Math.max(deepest, subtreeHeight(child)), 0);

/** The chain of areas above `id`, from the root down to its parent. */
export function ancestors(areas: readonly Area[], id: string): Area[] {
  const byId = new Map(areas.map((area) => [area.id, area]));
  const chain: Area[] = [];
  let current = byId.get(id);
  const seen = new Set<string>();
  while (current?.parentId && !seen.has(current.id)) {
    seen.add(current.id);
    current = byId.get(current.parentId);
    if (current) chain.unshift(current);
  }
  return chain;
}

/** Default expansion: the roots are open, so the first two levels are visible. */
export const defaultExpanded = (roots: readonly AreaNode[]): Set<string> =>
  new Set(roots.filter((node) => node.children.length > 0).map((node) => node.area.id));

export interface ParentChoice {
  readonly id: string;
  /** Name indented by level, for a native select. */
  readonly label: string;
  /** Why the area cannot be the parent; `null` when it can. */
  readonly unavailable: string | null;
}

const NBSP = ' ';

/**
 * Candidate parents in tree order. `moving` is the area being created (null) or moved: it, its sub-areas, inactive
 * areas and areas that would push the subtree past four levels are listed but unavailable, with the reason.
 */
export function parentChoices(
  roots: readonly AreaNode[],
  moving: AreaNode | null,
): readonly ParentChoice[] {
  const blocked = new Set(moving ? [moving.area.id, ...descendantIds(moving)] : []);
  const height = moving ? subtreeHeight(moving) : 1;
  const out: ParentChoice[] = [];
  const walk = (nodes: readonly AreaNode[]) => {
    for (const node of nodes) {
      const { area } = node;
      let unavailable: string | null = null;
      if (blocked.has(area.id)) unavailable = 'esta área o una de sus sub-áreas';
      else if (!area.active) unavailable = 'inactiva';
      else if (area.depth + height > MAX_AREA_DEPTH) unavailable = 'superaría los 4 niveles';
      out.push({
        id: area.id,
        label: `${NBSP.repeat(Math.max(0, area.depth - 1) * 3)}${area.name}${area.code ? ` (${area.code})` : ''}${unavailable ? ` — no disponible: ${unavailable}` : ''}`,
        unavailable,
      });
      walk(node.children);
    }
  };
  walk(roots);
  return out;
}
