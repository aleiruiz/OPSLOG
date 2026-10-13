import {
  IncidentError,
  type Incident,
  type IncidentActor,
} from '../../../../../packages/domain/incidents/cases/src/index.js';
import type {
  IncidentApiDeps,
  IncidentApiErrorCode,
  IncidentApiResponse,
  IncidentListView,
  IncidentSuggestionsView,
  IncidentTimelineEntry,
  IncidentView,
} from './types.js';
import { namesFor, toSuggestions, toTimeline, toView, type Names } from './view.js';

export type * from './types.js';

const STATUS: Readonly<Record<IncidentApiErrorCode, number>> = {
  unauthorized: 401,
  forbidden: 403,
  invalid_input: 400,
  not_found: 404,
  stale_version: 409,
  invalid_transition: 409,
  rule_violation: 422,
  duplicate: 409,
  idempotency_conflict: 409,
  internal_error: 500,
};
const KNOWN = new Set<string>(Object.keys(STATUS));
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

function fail(error: unknown): IncidentApiResponse<never> {
  const raw =
    error instanceof IncidentError
      ? error.code
      : typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code: unknown }).code)
        : '';
  const code: IncidentApiErrorCode =
    raw === 'expired'
      ? 'unauthorized'
      : KNOWN.has(raw)
        ? (raw as IncidentApiErrorCode)
        : 'internal_error';
  return {
    ok: false,
    error: {
      code,
      status: STATUS[code],
      message: code === 'internal_error' ? 'Request failed' : `Incident request rejected: ${code}`,
      ...(error instanceof IncidentError && error.fieldErrors.length > 0
        ? { fieldErrors: error.fieldErrors }
        : {}),
      ...(error instanceof IncidentError && error.rule ? { rule: error.rule } : {}),
    },
  };
}

/** Incident endpoints. Tenant, actor, grants and mechanic scope come only from the session. */
export class IncidentApi {
  public constructor(private readonly deps: IncidentApiDeps) {}

  /** `entityId` is the requested incident, when the request names one (audited when access is refused). */
  private async run<T>(
    token: string,
    correlationId: string,
    entityId: string,
    work: (tenantId: string, actor: IncidentActor, names: Names) => Promise<T>,
  ): Promise<IncidentApiResponse<T>> {
    let denied: (() => Promise<void>) | null = null;
    try {
      const { context, permissions } = await this.deps.authorize(token, correlationId);
      const tenantId = context.tenantId;
      const actor: IncidentActor = {
        id: `user-${context.actor.subject}`,
        subject: context.actor.subject,
        permissions,
        mechanicLinked: await this.deps.mechanicLinked(tenantId, context.actor.subject),
      };
      denied = () =>
        this.deps.deny(
          context,
          'incident.access_denied',
          OPAQUE_ID.test(entityId) ? entityId : 'unknown',
          correlationId,
        );
      return { ok: true, value: await work(tenantId, actor, namesFor(tenantId, this.deps.labels)) };
    } catch (error) {
      if (
        denied &&
        error instanceof IncidentError &&
        (error.code === 'forbidden' || error.code === 'not_found')
      )
        // Best effort: the refusal is what the caller sees, whether or not the audit lands.
        await denied().catch(() => undefined);
      return fail(error);
    }
  }

  private one(
    token: string,
    correlationId: string,
    entityId: string,
    work: (tenantId: string, actor: IncidentActor) => Promise<Incident>,
  ): Promise<IncidentApiResponse<IncidentView>> {
    return this.run(token, correlationId, entityId, async (tenantId, actor, names) =>
      toView(await work(tenantId, actor), actor, names),
    );
  }

  public list(
    token: string,
    correlationId: string,
    query: unknown,
  ): Promise<IncidentApiResponse<IncidentListView>> {
    return this.run(token, correlationId, 'list', async (tenantId, actor, names) => {
      const page = await this.deps.incidents.list(tenantId, actor, query);
      return {
        items: await Promise.all(page.items.map((incident) => toView(incident, actor, names))),
        total: page.total,
        tenantId,
      };
    });
  }

  public create(
    token: string,
    correlationId: string,
    input: unknown,
    idempotencyKey?: string,
  ): Promise<IncidentApiResponse<IncidentView>> {
    return this.one(token, correlationId, 'new', (tenantId, actor) =>
      this.deps.incidents.create(tenantId, actor, input, idempotencyKey),
    );
  }

  public get(
    token: string,
    correlationId: string,
    id: string,
  ): Promise<IncidentApiResponse<IncidentView>> {
    return this.one(token, correlationId, id, (tenantId, actor) =>
      this.deps.incidents.get(tenantId, actor, id),
    );
  }

  public update(
    token: string,
    correlationId: string,
    id: string,
    input: unknown,
  ): Promise<IncidentApiResponse<IncidentView>> {
    return this.one(token, correlationId, id, (tenantId, actor) =>
      this.deps.incidents.update(tenantId, actor, id, input),
    );
  }

  public timeline(
    token: string,
    correlationId: string,
    id: string,
  ): Promise<IncidentApiResponse<readonly IncidentTimelineEntry[]>> {
    return this.run(token, correlationId, id, async (tenantId, actor, names) =>
      toTimeline(await this.deps.incidents.history(tenantId, actor, id), names),
    );
  }

  public suggestions(
    token: string,
    correlationId: string,
    query: unknown,
  ): Promise<IncidentApiResponse<IncidentSuggestionsView>> {
    return this.run(token, correlationId, 'suggestions', async (tenantId, actor) =>
      toSuggestions(await this.deps.incidents.suggestions(tenantId, actor, query)),
    );
  }
}
