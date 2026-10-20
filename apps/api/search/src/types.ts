import type { SearchResult, SearchService } from '../../../../packages/domain/search/src/index.js';

/** What the API needs of the platform: the session, its grants and the mechanic link. */
export interface SearchApiDeps {
  readonly authorize: (
    token: string,
    correlationId: string,
  ) => Promise<{
    readonly tenantId: string;
    readonly subject: string;
    readonly permissions: readonly string[];
  }>;
  readonly mechanicLinked: (tenantId: string, memberId: string) => Promise<boolean>;
  readonly service: Pick<SearchService, 'search'>;
}

export interface SearchApiQuery {
  readonly q: unknown;
  readonly types?: readonly unknown[];
}

export type SearchApiResponse =
  | { readonly ok: true; readonly value: SearchResult }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly status: number; readonly message: string };
    };
