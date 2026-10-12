import type { UsersPort } from '../../app/types';
import type { DirectoryOption } from './directory';

const PAGE = 100;
/** 1,000 people: beyond it the picker says so instead of silently dropping the rest. */
const MAX_PAGES = 10;

export interface LoadedMembers {
  readonly items: readonly DirectoryOption[];
  readonly truncated: boolean;
}

/**
 * The active people of the company, all pages, named by role and by their order within it
 * ("Operador 2"): the identity contract has no names or emails. A failed page keeps what was loaded.
 */
export async function loadMemberOptions(users: UsersPort): Promise<LoadedMembers | null> {
  const seen = new Map<string, number>();
  const items: DirectoryOption[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await users.listUsers({
      limit: PAGE,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (!result.ok) return page === 0 ? null : { items, truncated: true };
    for (const user of result.value.items) {
      if (user.status !== 'active') continue;
      const ordinal = (seen.get(user.roleLabel) ?? 0) + 1;
      seen.set(user.roleLabel, ordinal);
      items.push({ id: user.id, label: `${user.roleLabel} ${ordinal}` });
    }
    if (result.value.nextCursor === null) return { items, truncated: false };
    cursor = result.value.nextCursor;
  }
  return { items, truncated: true };
}
