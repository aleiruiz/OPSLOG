import type { ApiError, BffClient, BffSearchResult } from '@opslog/contracts';

type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ApiError };

/** What the search box and the results page need from the BFF (FR-160). Authorization stays on the server. */
export interface SearchPorts {
  query(q: string): Promise<Result<BffSearchResult>>;
}

export function createSearchPorts(client: BffClient): SearchPorts {
  return { query: (q) => client.call('search.query', { query: { q } }) };
}
