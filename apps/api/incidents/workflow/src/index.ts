import type {
  Incident,
  IncidentActor,
} from '../../../../../packages/domain/incidents/cases/src/index.js';
import { allowedCommands } from '../../../../../packages/domain/incidents/workflow/src/index.js';
import {
  namesFor,
  runSession,
  toView,
  type IncidentApiResponse,
  type IncidentView,
} from '../../cases/src/index.js';
import type { IncidentWorkflowApiDeps, NextStepsView } from './types.js';

export type * from './types.js';

/**
 * Workflow endpoints of a case: transitions, next steps and the process data. Tenant, actor, grants
 * and mechanic scope come only from the session.
 */
export class IncidentWorkflowApi {
  public constructor(private readonly deps: IncidentWorkflowApiDeps) {}

  private one(
    token: string,
    correlationId: string,
    id: string,
    work: (tenantId: string, actor: IncidentActor) => Promise<Incident>,
  ): Promise<IncidentApiResponse<IncidentView>> {
    return runSession(this.deps, token, correlationId, id, async (tenantId, actor) => {
      const incident = await work(tenantId, actor);
      // The view the caller gets back already says what they may do next.
      return toView(
        incident,
        actor,
        namesFor(tenantId, this.deps.labels),
        allowedCommands(incident, actor),
      );
    });
  }

  public transition(
    token: string,
    correlationId: string,
    id: string,
    input: unknown,
    idempotencyKey?: string,
  ): Promise<IncidentApiResponse<IncidentView>> {
    return this.one(token, correlationId, id, (tenantId, actor) =>
      this.deps.workflow.execute(tenantId, actor, id, input, idempotencyKey),
    );
  }

  public nextSteps(
    token: string,
    correlationId: string,
    id: string,
  ): Promise<IncidentApiResponse<NextStepsView>> {
    return runSession(this.deps, token, correlationId, id, async (tenantId, actor) => ({
      items: await this.deps.workflow.nextSteps(tenantId, actor, id),
    }));
  }

  public updateInsurance(
    token: string,
    correlationId: string,
    id: string,
    input: unknown,
  ): Promise<IncidentApiResponse<IncidentView>> {
    return this.one(token, correlationId, id, (tenantId, actor) =>
      this.deps.process.updateInsurance(tenantId, actor, id, input),
    );
  }

  public updateResolution(
    token: string,
    correlationId: string,
    id: string,
    input: unknown,
  ): Promise<IncidentApiResponse<IncidentView>> {
    return this.one(token, correlationId, id, (tenantId, actor) =>
      this.deps.process.updateResolution(tenantId, actor, id, input),
    );
  }
}
