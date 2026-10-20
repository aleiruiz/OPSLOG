import React from 'react';
import type { ApiError, BffSearchResult } from '@opslog/contracts';
import { MIN_SEARCH_LENGTH } from './labels';
import type { SearchPorts } from './ports';

export type SearchState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly result: BffSearchResult }
  | { readonly status: 'error'; readonly error: ApiError };

/**
 * Searches `q` after `delayMs`; a response from an older term never overwrites a newer one and a
 * 401 is handed to the shared session handling.
 */
export function useSearch(
  ports: SearchPorts,
  q: string,
  onExpired: () => void,
  delayMs = 200,
): SearchState {
  const [state, setState] = React.useState<SearchState>({ status: 'idle' });
  const term = q.trim();
  React.useEffect(() => {
    if (term.length < MIN_SEARCH_LENGTH) {
      setState({ status: 'idle' });
      return undefined;
    }
    let current = true;
    setState({ status: 'loading' });
    const timer = setTimeout(() => {
      void ports.query(term).then((result) => {
        if (!current) return;
        if (result.ok) setState({ status: 'ready', result: result.value });
        else {
          if (result.error.status === 401) onExpired();
          setState({ status: 'error', error: result.error });
        }
      });
    }, delayMs);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [ports, term, delayMs]);
  return state;
}

export const totalHits = (result: BffSearchResult): number =>
  result.groups.reduce((sum, group) => sum + group.total, 0);
