import {
  IDEMPOTENCY_KEY,
  IDEMPOTENCY_TTL_MS,
  IncidentError,
  can,
  isMechanicScoped,
  type IdempotencyClaim,
  type Incident,
  type IncidentActor,
  type IncidentEvent,
  type IncidentStore,
  type TimelineBefore,
} from '../../cases/src/index.js';
import { opaqueId } from '../../cases/src/validation.js';
import type { WorkflowPorts } from './ports.js';

export interface WorkflowOptions {
  readonly now?: () => Date;
  /** How long a recorded Idempotency-Key stays valid (default 24 h). */
  readonly idempotencyTtlMs?: number;
}

/** Structured facts of the case before a change: ids, enums and flags, never free text or amounts. */
export function workflowBefore(incident: Incident): TimelineBefore {
  return {
    cycle: incident.cycle,
    reopenCount: incident.reopenCount,
    responsibleId: incident.responsibleId,
    coverageStatus: incident.coverageStatus,
    policyId: incident.policySnapshot?.policyId ?? null,
    insurerResult: incident.insurerResult,
    costAssumed: incident.costAssumed,
    totalLoss: incident.totalLoss,
    vehicleStatusDecision: incident.vehicleStatusDecision,
  };
}

export interface Commit {
  readonly tenantId: string;
  readonly actor: IncidentActor;
  /** The case as it was read (its `version` is what the write is conditional on). */
  readonly incident: Incident;
  /** The case with the command's changes applied; the version and the audit stamp are set here. */
  readonly next: Incident;
  readonly command: string;
  readonly changed: readonly string[];
  readonly comment: string | null;
  readonly event: (written: Incident) => IncidentEvent;
  readonly claim?: IdempotencyClaim;
}

/** What the commands and the process data share: who sees a case, and the single atomic write. */
export abstract class WorkflowBase {
  protected readonly now: () => Date;
  protected readonly ttl: number;
  protected constructor(
    protected readonly store: IncidentStore,
    protected readonly ports: WorkflowPorts,
    options: WorkflowOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.ttl = options.idempotencyTtlMs ?? IDEMPOTENCY_TTL_MS;
  }

  /** Reading needs `incidents:view`; a mechanic-scoped member sees no case at all (404). */
  protected async visible(tenantId: string, actor: IncidentActor, id: string): Promise<Incident> {
    if (!can(actor, 'incidents:view')) throw new IncidentError('forbidden');
    const wanted = opaqueId(id);
    const incident =
      wanted === undefined || isMechanicScoped(actor)
        ? null
        : await this.store.get(tenantId, wanted);
    if (!incident) throw new IncidentError('not_found');
    return incident;
  }

  protected keyOf(key: string | undefined): string | undefined {
    if (key !== undefined && !IDEMPOTENCY_KEY.test(key))
      throw new IncidentError('invalid_input', [{ field: 'idempotencyKey', code: 'invalid' }]);
    return key;
  }

  /** One transaction: the case (version CAS), its timeline entry, audit, outbox event and the key. */
  protected async commit(commit: Commit): Promise<Incident> {
    const { actor, incident } = commit;
    const time = this.now().toISOString();
    const written: Incident = {
      ...commit.next,
      version: incident.version + 1,
      updatedAt: time,
      updatedBy: actor.id,
    };
    const result = await this.store.apply({
      incident: written,
      expectedVersion: incident.version,
      folioYear: null,
      transitions: [
        {
          command: commit.command,
          from: incident.status,
          to: written.status,
          actorId: actor.id,
          comment: commit.comment,
          occurredAt: time,
          changedFields: [...commit.changed].sort(),
          before: workflowBefore(incident),
        },
      ],
      auditActions: [`incident.${commit.command}`],
      events: [commit.event(written)],
      ...(commit.claim ? { idempotency: commit.claim } : {}),
    });
    if (!result.applied) throw new IncidentError('stale_version');
    return result.incident;
  }

  protected claim(
    actor: IncidentActor,
    command: string,
    key: string,
    incident: Incident,
    hash: string,
  ): IdempotencyClaim {
    const createdAt = this.now();
    return {
      actorId: actor.id,
      command,
      key,
      incidentId: incident.id,
      payloadHash: hash,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + this.ttl).toISOString(),
    };
  }
}
