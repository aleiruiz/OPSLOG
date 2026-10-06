import type { Area, AreaDetail, AreasPort, Result } from '../app/types';

/** The listing returns at most 100 areas per page; a company has far fewer, so the pages are followed to the end. */
const PAGE_SIZE = 100;
/** Safety bound against a server that never ends the pagination: 20 pages hold 2,000 areas. */
const MAX_PAGES = 20;

export interface AreaCatalog {
  readonly areas: readonly Area[];
  /** More areas exist than the pages that were followed. */
  readonly truncated: boolean;
}

/** Every area of the company (every level), following the cursor. Inactive areas only when asked for. */
export async function loadAllAreas(
  areas: AreasPort,
  includeInactive: boolean,
): Promise<Result<AreaCatalog>> {
  const items: Area[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await areas.list({
      limit: PAGE_SIZE,
      ...(cursor === undefined ? {} : { cursor }),
      includeInactive: includeInactive ? 'true' : 'false',
    });
    if (!result.ok) return result;
    items.push(...result.value.items);
    if (result.value.nextCursor === null)
      return { ok: true, value: { areas: items, truncated: false } };
    cursor = result.value.nextCursor;
  }
  return { ok: true, value: { areas: items, truncated: true } };
}

export interface AreaContext extends AreaCatalog {
  readonly area: AreaDetail;
}

/** One area with its resource counts, plus the whole tree (inactive included) to place it: path, sub-areas, parents. */
export async function loadAreaContext(areas: AreasPort, id: string): Promise<Result<AreaContext>> {
  const [detail, catalog] = await Promise.all([areas.get(id), loadAllAreas(areas, true)]);
  if (!detail.ok) return detail;
  if (!catalog.ok) return catalog;
  return { ok: true, value: { ...catalog.value, area: detail.value } };
}
