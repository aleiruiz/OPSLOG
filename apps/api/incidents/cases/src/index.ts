import type {
  Incident,
  IncidentActor,
} from '../../../../../packages/domain/incidents/cases/src/index.js';
import type {
  IncidentApiDeps,
  IncidentApiResponse,
  IncidentListView,
  IncidentSuggestionsView,
  IncidentTimelineEntry,
  IncidentView,
} from './types.js';
import { runSession } from './session.js';
import { namesFor, toSuggestions, toTimeline, toView, type Names } from './view.js';

export type * from './types.js';
export { fail, runSession, type SessionDeps } from './session.js';
export { namesFor, toView, type Names } from './view.js';

/** Incident endpoints. Tenant, actor, grants and mechanic scope come only from the session. */
export class IncidentApi {
  public constructor(private readonly deps: IncidentApiDeps) {}

  private run<T>(
    token: string,
    correlationId: string,
    entityId: string,
    work: (tenantId: string, actor: IncidentActor, names: Names) => Promise<T>,
  ): Promise<IncidentApiResponse<T>> {
    return runSession(this.deps, token, correlationId, entityId, (tenantId, actor) =>
      work(tenantId, actor, namesFor(tenantId, this.deps.labels)),
    );
  }

  private view(incident: Incident, actor: IncidentActor, names: Names): Promise<IncidentView> {
    return toView(incident, actor, names, this.deps.allowedCommands?.(incident, actor));
  }

  private one(
    token: string,
    correlationId: string,
    entityId: string,
    work: (tenantId: string, actor: IncidentActor) => Promise<Incident>,
  ): Promise<IncidentApiResponse<IncidentView>> {
    return this.run(token, correlationId, entityId, async (tenantId, actor, names) =>
      this.view(await work(tenantId, actor), actor, names),
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
        items: await Promise.all(
          page.items.map((incident) =>
            toView(incident, actor, names, this.deps.allowedCommands?.(incident, actor)),
          ),
        ),
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
