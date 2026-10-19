import { SavedViewError } from '../../../../packages/domain/saved-views/src/index.js';
import type {
  ColumnsProjection,
  ViewProjection,
} from '../../../../packages/domain/saved-views/src/index.js';
import type { SavedViewsApiDeps, SavedViewsApiResponse } from './types.js';

export type * from './types.js';

const STATUS: Readonly<Record<string, number>> = {
  invalid_input: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  stale_version: 409,
  duplicate: 409,
  rule_violation: 422,
};

/** A failure as a fixed code and message: never a name, a filter, a stack or a store detail. */
function fail(error: unknown): SavedViewsApiResponse<never> {
  const raw = (error as { code?: unknown } | null)?.code;
  const named = error instanceof SavedViewError && error.code === 'limit_reached';
  const code = named
    ? 'rule_violation'
    : raw === 'expired'
      ? 'unauthorized'
      : typeof raw === 'string'
        ? raw
        : '';
  const known = code in STATUS ? code : 'internal_error';
  return {
    ok: false,
    error: {
      code: known,
      status: STATUS[known] ?? 500,
      message:
        known === 'internal_error' ? 'Request failed' : `Saved view request rejected: ${known}`,
      ...(named ? { rule: 'view_limit' } : {}),
    },
  };
}

/**
 * Saved views and visible columns. The company, the reader and their grants come only from the
 * session; no request names them. A foreign private view is a 404, a shared one of another member a 403.
 */
export class SavedViewsApi {
  public constructor(private readonly deps: SavedViewsApiDeps) {}

  private async run<T>(
    token: string,
    correlationId: string,
    work: (session: {
      tenantId: string;
      viewer: { memberId: string; permissions: ReadonlySet<string> };
    }) => Promise<T>,
  ): Promise<SavedViewsApiResponse<T>> {
    try {
      const session = await this.deps.authorize(token, correlationId);
      const value = await work({
        tenantId: session.tenantId,
        viewer: { memberId: session.subject, permissions: new Set(session.permissions) },
      });
      return { ok: true, value };
    } catch (error) {
      return fail(error);
    }
  }

  public list(token: string, correlationId: string, module: unknown) {
    return this.run(token, correlationId, async (s) => ({
      items: await this.deps.service.list(s.tenantId, s.viewer, module),
    }));
  }

  public create(
    token: string,
    correlationId: string,
    module: unknown,
    input: Record<string, unknown>,
  ) {
    return this.run<ViewProjection>(token, correlationId, (s) =>
      this.deps.service.create(s.tenantId, s.viewer, module, input),
    );
  }

  public update(token: string, correlationId: string, id: unknown, patch: Record<string, unknown>) {
    return this.run<ViewProjection>(token, correlationId, (s) =>
      this.deps.service.update(s.tenantId, s.viewer, id, patch),
    );
  }

  public remove(token: string, correlationId: string, id: unknown) {
    return this.run<void>(token, correlationId, (s) =>
      this.deps.service.remove(s.tenantId, s.viewer, id),
    );
  }

  public columns(token: string, correlationId: string, module: unknown) {
    return this.run<ColumnsProjection>(token, correlationId, (s) =>
      this.deps.service.columns(s.tenantId, s.viewer, module),
    );
  }

  public saveColumns(token: string, correlationId: string, module: unknown, columns: unknown) {
    return this.run<ColumnsProjection>(token, correlationId, (s) =>
      this.deps.service.saveColumns(s.tenantId, s.viewer, module, columns),
    );
  }
}
