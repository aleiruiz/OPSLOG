import type { SavedViewService } from '../../../../packages/domain/saved-views/src/index.js';

/** What the API needs of the platform: the session and the grants of its role. */
export interface SavedViewsApiDeps {
  readonly authorize: (
    token: string,
    correlationId: string,
  ) => Promise<{
    readonly tenantId: string;
    readonly subject: string;
    readonly permissions: readonly string[];
  }>;
  readonly service: Pick<
    SavedViewService,
    'list' | 'create' | 'update' | 'remove' | 'columns' | 'saveColumns'
  >;
}

export type SavedViewsApiResponse<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: string;
        readonly status: number;
        readonly message: string;
        /** Id of the broken business rule of a 422. */
        readonly rule?: string;
      };
    };
