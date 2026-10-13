import { createHash, randomUUID } from 'node:crypto';
import {
  IDEMPOTENCY_KEY,
  IDEMPOTENCY_TTL_MS,
  INCIDENT_UPDATED_EVENT,
  IncidentError,
  TERMINAL_STATUSES,
  can,
  canEdit,
  isMechanicScoped,
  type IdempotencyRecord,
  type Incident,
  type IncidentActor,
  type IncidentStore,
  type IncidentTimelineCommand,
  type TimelineBefore,
} from '../../cases/src/index.js';
import { opaqueId } from '../../cases/src/validation.js';
import type { ChildChange, IncidentChildStore } from './types.js';

export interface ChildServiceOptions {
  readonly now?: () => Date;
  readonly newId?: () => string;
  /** How long a recorded Idempotency-Key stays valid (default 24 h). */
  readonly idempotencyTtlMs?: number;
}

/** A command with an Idempotency-Key: the key, the hash of what it asked for and the id it creates. */
export interface KeyedCommand {
  readonly command: string;
  readonly key: string;
  readonly hash: string;
}

export interface ChildCommit {
  readonly tenantId: string;
  readonly actor: IncidentActor;
  readonly incident: Incident;
  readonly command: IncidentTimelineCommand;
  /** Names of the fields the command touched, never their values. */
  readonly changed: readonly string[];
  /** Structured facts (ids, enums) the timeline keeps; never free text or personal data. */
  readonly before: TimelineBefore | null;
  readonly change: ChildChange;
  readonly keyed?: KeyedCommand;
}

/** A concurrent twin with the same Idempotency-Key won; its stored result is the answer. */
export class TwinWon extends Error {
  public constructor(public readonly record: IdempotencyRecord) {
    super('Idempotency-Key already used');
  }
}

/** An id the same (tenant, actor, command, key) always gets, so a replay finds what the first call made. */
export const keyedId = (tenantId: string, actorId: string, command: string, key: string): string =>
  createHash('sha256')
    .update(JSON.stringify([tenantId, actorId, command, key]))
    .digest('hex')
    .slice(0, 32);

/**
 * What the children of a case share: who may read and write (the same grants as the case), the
 * state guard (closed and cancelled cases accept no write), the version check and the single
 * transaction that bumps the case, records the timeline, audit and outbox and writes the child.
 */
export abstract class ChildServiceBase {
  protected readonly now: () => Date;
  protected readonly newId: () => string;
  protected readonly ttl: number;
  protected constructor(
    protected readonly incidents: IncidentStore,
    protected readonly children: IncidentChildStore,
    options: ChildServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
    this.ttl = options.idempotencyTtlMs ?? IDEMPOTENCY_TTL_MS;
  }

  /** Reading needs `incidents:view`; a mechanic-scoped member sees no case at all. */
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

  /** The case to write on: `incidents:edit`, or the author with `incidents:report` while it is a draft. */
  protected async writable(tenantId: string, actor: IncidentActor, id: string): Promise<Incident> {
    const incident = await this.visible(tenantId, actor, id);
    if (!canEdit(actor, incident)) throw new IncidentError('forbidden');
    return incident;
  }

  /** Closed and cancelled cases are immutable (409), then the version the caller read must be current. */
  protected assertOpen(incident: Incident, version: number): void {
    if (TERMINAL_STATUSES.includes(incident.status)) throw new IncidentError('invalid_transition');
    if (incident.version !== version) throw new IncidentError('stale_version');
  }

  protected keyOf(key: string | undefined): string | undefined {
    if (key !== undefined && !IDEMPOTENCY_KEY.test(key))
      throw new IncidentError('invalid_input', [{ field: 'idempotencyKey', code: 'invalid' }]);
    return key;
  }

  /** The live record of a key that was already used by this actor for this command, if any. */
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

  /** One transaction: the case (version CAS), its timeline entry, audit, outbox and the child write. */
  protected async commit(commit: ChildCommit): Promise<Incident> {
    const { tenantId, actor, incident, keyed } = commit;
    const now = this.now();
    const time = now.toISOString();
    const next: Incident = {
      ...incident,
      version: incident.version + 1,
      updatedAt: time,
      updatedBy: actor.id,
    };
    const result = await this.children.apply(
      {
        incident: next,
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
        events: [
          {
            type: INCIDENT_UPDATED_EVENT,
            payload: { incidentId: incident.id, version: next.version },
          },
        ],
        ...(keyed
          ? {
              idempotency: {
                actorId: actor.id,
                command: keyed.command,
                key: keyed.key,
                incidentId: incident.id,
                payloadHash: keyed.hash,
                createdAt: time,
                expiresAt: new Date(now.getTime() + this.ttl).toISOString(),
              },
            }
          : {}),
      },
      commit.change,
    );
    if (result.applied) return result.incident;
    const twin = keyed ? await this.replay(tenantId, actor, keyed) : null;
    if (twin) throw new TwinWon(twin);
    // The version is unchanged, so the refusal was the file already linked, not a lost race.
    const current = await this.incidents.get(tenantId, incident.id);
    throw new IncidentError(current?.version === incident.version ? 'duplicate' : 'stale_version');
  }
}
