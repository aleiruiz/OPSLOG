import React from 'react';
import type { BffAuditEntry, BffAuditPage } from '@opslog/contracts';
import { useResource, type ResourceState } from '../../app/resource';
import { useSession } from '../../auth/session';
import type { Result } from '../../app/types';

export interface PagedAudit {
  readonly state: ResourceState<BffAuditPage>;
  /** Every loaded event, newest first (first page plus the pages loaded afterwards). */
  readonly entries: readonly BffAuditEntry[];
  readonly nextCursor: string | null;
  readonly loadingMore: boolean;
  readonly moreFailed: boolean;
  readonly reload: () => void;
  readonly loadMore: () => void;
}

/**
 * The first page of an audit listing plus keyset «load more». Changing `deps` (the filters) starts over; a
 * page that arrives after the filters changed is dropped.
 */
export function usePagedAudit(
  load: (cursor?: string) => Promise<Result<BffAuditPage>>,
  deps: React.DependencyList,
): PagedAudit {
  const { markExpired } = useSession();
  const { state, reload } = useResource(() => load(), deps);
  const [extra, setExtra] = React.useState<{
    base: BffAuditPage;
    entries: readonly BffAuditEntry[];
    next: string | null;
  } | null>(null);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [moreFailed, setMoreFailed] = React.useState(false);

  const first = state.status === 'ready' ? state.data : null;
  // The pages loaded afterwards belong to the first page they extend: a new first page drops them.
  const mine = extra !== null && extra.base === first ? extra : null;
  const firstRef = React.useRef(first);
  firstRef.current = first;
  const nextCursor = mine ? mine.next : (first?.nextCursor ?? null);
  const entries = first ? [...first.items, ...(mine?.entries ?? [])] : [];

  const loadMore = () => {
    if (!nextCursor || !first || loadingMore) return;
    const base = first;
    setLoadingMore(true);
    setMoreFailed(false);
    void load(nextCursor).then((result) => {
      if (firstRef.current !== base) {
        setLoadingMore(false);
        return;
      }
      setLoadingMore(false);
      if (result.ok)
        setExtra({
          base,
          entries: [...(mine?.entries ?? []), ...result.value.items],
          next: result.value.nextCursor,
        });
      else {
        if (result.error.status === 401) markExpired();
        setMoreFailed(true);
      }
    });
  };

  return { state, entries, nextCursor, loadingMore, moreFailed, reload, loadMore };
}
