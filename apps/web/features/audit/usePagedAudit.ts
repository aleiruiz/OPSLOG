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
    entries: readonly BffAuditEntry[];
    next: string | null;
  } | null>(null);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [moreFailed, setMoreFailed] = React.useState(false);
  const generation = React.useRef(0);

  React.useEffect(() => {
    generation.current += 1;
    setExtra(null);
    setLoadingMore(false);
    setMoreFailed(false);
  }, [state]);

  const first = state.status === 'ready' ? state.data : null;
  const nextCursor = extra ? extra.next : (first?.nextCursor ?? null);
  const entries = first ? [...first.items, ...(extra?.entries ?? [])] : [];

  const loadMore = () => {
    if (!nextCursor || loadingMore) return;
    const mine = generation.current;
    setLoadingMore(true);
    setMoreFailed(false);
    void load(nextCursor).then((result) => {
      if (mine !== generation.current) return;
      setLoadingMore(false);
      if (result.ok)
        setExtra({
          entries: [...(extra?.entries ?? []), ...result.value.items],
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
