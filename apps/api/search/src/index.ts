import { isPoolSaturation } from '../../../../packages/platform/observability/src/index.js';
import type { SearchApiDeps, SearchApiQuery, SearchApiResponse } from './types.js';

export type * from './types.js';

const STATUS: Readonly<Record<string, number>> = {
  invalid_input: 400,
  unauthorized: 401,
  forbidden: 403,
};

/** A failure as a fixed code and message: never what was typed, a stack or a store detail. */
function fail(error: unknown): SearchApiResponse {
  if (isPoolSaturation(error))
    return {
      ok: false,
      error: { code: 'unavailable', status: 503, message: 'Service temporarily unavailable' },
    };
  const raw = (error as { code?: unknown } | null)?.code;
  const code = raw === 'expired' ? 'unauthorized' : typeof raw === 'string' ? raw : '';
  const known = code in STATUS ? code : 'internal_error';
  return {
    ok: false,
    error: {
      code: known,
      status: STATUS[known] ?? 500,
      message: known === 'internal_error' ? 'Request failed' : `Search request rejected: ${known}`,
    },
  };
}

/**
 * Global search endpoint (`GET /search`). The company, the reader and their grants come only from
 * the session; the query names none of them. The answer holds only what that reader may see.
 */
export class SearchApi {
  public constructor(private readonly deps: SearchApiDeps) {}

  public async search(
    token: string,
    correlationId: string,
    query: SearchApiQuery,
  ): Promise<SearchApiResponse> {
    try {
      const session = await this.deps.authorize(token, correlationId);
      const value = await this.deps.service.search(
        session.tenantId,
        {
          permissions: new Set(session.permissions),
          mechanicLinked: await this.deps.mechanicLinked(session.tenantId, session.subject),
        },
        query.q,
        query.types,
      );
      return { ok: true, value };
    } catch (error) {
      return fail(error);
    }
  }
}
