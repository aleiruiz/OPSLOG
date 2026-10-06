import type { Area } from '../app/types';
import { buildTree, allNodes } from './tree';

/** One option of an area selector. */
export interface AreaChoice {
  readonly id: string;
  /** Name indented by level, for a native select; inactive areas say so. */
  readonly label: string;
  /** Inactive areas cannot be assigned (the backend answers 422 `invalid_area`). */
  readonly disabled: boolean;
}

const INDENT = '\u00A0\u00A0';

/**
 * The company's areas in tree order, for a selector. Only active areas can be chosen; an inactive one is listed
 * (disabled) so the tree still reads, except `keep`: the area a record already has stays selectable, because the
 * server keeps an unchanged area even when it was deactivated since.
 */
export function areaChoices(
  areas: readonly Area[],
  keep: string | null = null,
): readonly AreaChoice[] {
  return allNodes(buildTree(areas)).map(({ area }) => ({
    id: area.id,
    label: `${INDENT.repeat(Math.max(0, area.depth - 1))}${area.name}${area.active ? '' : ' (inactiva)'}`,
    disabled: !area.active && area.id !== keep,
  }));
}

/** Whether any area can be chosen at all. */
export const hasAssignableArea = (choices: readonly AreaChoice[]): boolean =>
  choices.some((choice) => !choice.disabled);
