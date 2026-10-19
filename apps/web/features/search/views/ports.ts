import type {
  ApiError,
  BffClient,
  BffListColumns,
  BffListModule,
  BffSavedView,
  BffSavedViewInput,
  BffSavedViewPatch,
} from '@opslog/contracts';

type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ApiError };

/** What the lists need from the BFF for saved views and persistent columns (FR-162). Authorization stays on the server. */
export interface ViewsPorts {
  list(module: BffListModule): Promise<Result<{ readonly items: readonly BffSavedView[] }>>;
  create(input: BffSavedViewInput): Promise<Result<BffSavedView>>;
  update(id: string, patch: BffSavedViewPatch): Promise<Result<BffSavedView>>;
  remove(id: string): Promise<Result<void>>;
  columns(module: BffListModule): Promise<Result<BffListColumns>>;
  saveColumns(
    module: BffListModule,
    columns: readonly string[] | null,
  ): Promise<Result<BffListColumns>>;
}

export function createViewsPorts(client: BffClient): ViewsPorts {
  return {
    list: (module) => client.call('views.list', { query: { module } }),
    create: (body) => client.call('views.create', { body }),
    update: (id, body) => client.call('views.update', { params: { id }, body }),
    remove: (id) => client.call('views.delete', { params: { id } }),
    columns: (module) => client.call('views.columns', { params: { module } }),
    saveColumns: (module, columns) =>
      client.call('views.columnsSave', { params: { module }, body: { columns } }),
  };
}
