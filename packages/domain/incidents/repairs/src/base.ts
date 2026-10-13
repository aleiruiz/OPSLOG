import { randomUUID } from 'node:crypto';
import {
  IDEMPOTENCY_KEY,
  IDEMPOTENCY_TTL_MS,
  IncidentError,
  can,
  isMechanicScoped,
  type IdempotencyRecord,
  type Incident,
  type IncidentActor,
  type IncidentApplyResult,
  type IncidentEvent,
  type IncidentMutation,
  type IncidentStore,
  type IncidentTimelineCommand,
  type TimelineBefore,
} from '../../cases/src/index.js';
import { opaqueId } from '../../cases/src/validation.js';
import { TwinWon, type KeyedCommand } from '../../third-parties/src/index.js';

export { TwinWon, keyedId, type KeyedCommand } from '../../third-parties/src/index.js';

export interface WriteOptions {
  readonly now?: () => Date;
  readonly newId?: () => string;
  /** How long a recorded Idempotency-Key stays valid (default 24 h). */
  readonly idempotencyTtlMs?: number;
}

export interface WriteCommit {
  readonly tenantId: string;
  readonly actor: IncidentActor;
  readonly incident: Incident;
  /** The case with the command's changes applied; version and audit stamp are set here. */
  readonly next: Incident;
  readonly command: IncidentTimelineCommand;
  /** Names of the fields the command touched, never their values. */
  readonly changed: readonly string[];
  /** Ids and enums, never amounts, free text or personal data. */
  readonly before: TimelineBefore | null;
  readonly event: (written: Incident) => IncidentEvent;
  /** Writes the child rows through the store of the module, in the transaction of the case. */
  readonly write: (mutation: IncidentMutation) => Promise<IncidentApplyResult>;
  /** Every write of INC-COSTS carries an Idempotency-Key. */
  readonly keyed: KeyedCommand;
}

/** D20 approvals covered what the supervisor saw: a change of costs or links asks for them again. */
export function withoutApprovals(incident: Incident): {
  readonly next: Incident;
  readonly cleared: readonly string[];
} {
  const cleared = [
    ...(incident.assumptionApproval ? ['assumptionApproval'] : []),
    ...(incident.closeApproval ? ['closeApproval'] : []),
  ];
  return { next: { ...incident, assumptionApproval: null, closeApproval: null }, cleared };
}

/**
 * What the writes of INC-COSTS share: who sees a case, who may write it, the Idempotency-Key and
 * the single transaction (case CAS, timeline, audit, outbox and the child rows).
 */
export abstract class IncidentWriteBase {
  protected readonly now: () => Date;
  protected readonly newId: () => string;
  protected readonly ttl: number;
  protected constructor(
    protected readonly incidents: IncidentStore,
    options: WriteOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
    this.ttl = options.idempotencyTtlMs ?? IDEMPOTENCY_TTL_MS;
  }

  /** Reading needs `incidents:view`; a mechanic-scoped member sees no case at all (404). */
  protected async visible(tenantId: string, actor: IncidentActor, id: string): Promise<Incident> {
    if (!can(actor, 'incidents:view')) throw new IncidentError('forbidden');
    const wanted = opaqueId(id);
    const incident =
      wanted === undefined || isMechanicScoped(actor)
        ? null
        : await this.incidents.get(tenantId, wanted);
    if (!incident) throw new IncidentError('not_found');
    return incident;
  }

  /** Writing needs `incidents:edit` (the generic verbs grant nothing, ADR-0014). */
  protected requireEdit(actor: IncidentActor): void {
    if (!can(actor, 'incidents:edit')) throw new IncidentError('forbidden');
  }

  /** The key is mandatory: these commands move money or its evidence (SPECS §5.2). */
  protected requiredKey(key: string | undefined): string {
    if (key === undefined) throw new IncidentError('idempotency_key_required');
    if (!IDEMPOTENCY_KEY.test(key))
      throw new IncidentError('invalid_input', [{ field: 'idempotencyKey', code: 'invalid' }]);
    return key;
  }

  protected async replay(
    tenantId: string,
    actor: IncidentActor,
    keyed: KeyedCommand,
  ): Promise<IdempotencyRecord | null> {
    const record = await this.incidents.idempotency(tenantId, actor.id, keyed.command, keyed.key);
    if (!record || record.expiresAt <= this.now().toISOString()) return null;
    if (record.payloadHash !== keyed.hash) throw new IncidentError('idempotency_conflict');
    return record;
  }

  protected async commit(commit: WriteCommit): Promise<Incident> {
    const { tenantId, actor, incident, keyed } = commit;
    const now = this.now();
    const time = now.toISOString();
    const written: Incident = {
      ...commit.next,
      version: incident.version + 1,
      updatedAt: time,
      updatedBy: actor.id,
    };
    const result = await commit.write({
      incident: written,
      expectedVersion: incident.version,
      folioYear: null,
      transitions: [
        {
          command: commit.command,
          from: incident.status,
          to: incident.status,
          actorId: actor.id,
          comment: null,
          occurredAt: time,
          changedFields: [...commit.changed].sort(),
          before: commit.before,
        },
      ],
      auditActions: [`incident.${commit.command}`],
      events: [commit.event(written)],
      idempotency: {
        actorId: actor.id,
        command: keyed.command,
        key: keyed.key,
        incidentId: incident.id,
        payloadHash: keyed.hash,
        createdAt: time,
        expiresAt: new Date(now.getTime() + this.ttl).toISOString(),
      },
    });
    if (result.applied) return result.incident;
    const twin = await this.replay(tenantId, actor, keyed);
    if (twin) throw new TwinWon(twin);
    // An unchanged version means the refusal was a taken uniqueness (the order is linked), not a lost race.
    const current = await this.incidents.get(tenantId, incident.id);
    throw new IncidentError(current?.version === incident.version ? 'duplicate' : 'stale_version');
  }
}
