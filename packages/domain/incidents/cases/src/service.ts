import { randomUUID } from 'node:crypto';
import {
  can,
  canCreate,
  canEdit,
  canSuggest,
  isMechanicScoped,
  type IncidentActor,
} from './access.js';
import {
  candidatesOn,
  assignmentsAt,
  driverSuggestions,
  resolveCoverage,
  type Coverage,
  type DriverSuggestion,
} from './coverage.js';
import { IncidentError } from './errors.js';
import { dayInZone, folioYear } from './folio.js';
import {
  IDEMPOTENCY_KEY,
  IDEMPOTENCY_TTL_MS,
  payloadHash,
  type IdempotencyClaim,
} from './idempotency.js';
import { parseCreate, parseListQuery, parseSuggestionQuery, parseUpdate } from './input.js';
import type { IncidentReferences, IncidentStore } from './ports.js';
import { assertEditable, assertEventTime } from './rules.js';
import {
  INCIDENT_CREATED_EVENT,
  INCIDENT_UPDATED_EVENT,
  type Incident,
  type IncidentPage,
  type IncidentTransition,
  type NewIncidentTransition,
  type PolicySnapshot,
  type TimelineBefore,
} from './types.js';
import { opaqueId } from './validation.js';
import { beforeOf, currentValue, newIncident } from './draft.js';
import { mergeChanges, requireDriver } from './merge.js';

export interface IncidentServiceOptions {
  readonly now?: () => Date;
  readonly newId?: () => string;
  /** How long a recorded Idempotency-Key stays valid (default 24 h). */
  readonly idempotencyTtlMs?: number;
}
export interface IncidentSuggestions {
  readonly drivers: readonly DriverSuggestion[];
  readonly policies: readonly PolicySnapshot[];
  readonly coverageStatus: Coverage['status'];
}

/** Incident cases: draft, edit, list, detail, timeline and suggestions (INC-CASES PR 1). */
export class IncidentService {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly ttl: number;
  public constructor(
    private readonly store: IncidentStore,
    private readonly refs: IncidentReferences,
    options: IncidentServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
    this.ttl = options.idempotencyTtlMs ?? IDEMPOTENCY_TTL_MS;
  }

  /** Reading needs `incidents:view`; a scoped member sees no case at all. */
  private async visible(tenantId: string, actor: IncidentActor, id: string): Promise<Incident> {
    if (!can(actor, 'incidents:view')) throw new IncidentError('forbidden');
    const wanted = opaqueId(id);
    const incident =
      wanted === undefined || isMechanicScoped(actor)
        ? null
        : await this.store.get(tenantId, wanted);
    if (!incident) throw new IncidentError('not_found');
    return incident;
  }

  public get(tenantId: string, actor: IncidentActor, id: string): Promise<Incident> {
    return this.visible(tenantId, actor, id);
  }

  public async history(
    tenantId: string,
    actor: IncidentActor,
    id: string,
  ): Promise<readonly IncidentTransition[]> {
    const incident = await this.visible(tenantId, actor, id);
    return this.store.history(tenantId, incident.id);
  }

  public async list(tenantId: string, actor: IncidentActor, input: unknown): Promise<IncidentPage> {
    if (!can(actor, 'incidents:view')) throw new IncidentError('forbidden');
    if (isMechanicScoped(actor)) return { items: [], total: 0 };
    return this.store.list(tenantId, parseListQuery(input, actor));
  }

  /** BR-I2 / BR-I3: drivers in force at the instant and policies covering the tenant day of the event. */
  public async suggestions(
    tenantId: string,
    actor: IncidentActor,
    input: unknown,
  ): Promise<IncidentSuggestions> {
    if (!can(actor, 'incidents:view') || !canSuggest(actor)) throw new IncidentError('forbidden');
    const query = parseSuggestionQuery(input);
    if (!(await this.refs.vehicle(tenantId, query.vehicleId))) throw new IncidentError('not_found');
    const zone = await this.refs.timeZone(tenantId);
    const inForce = assignmentsAt(
      await this.refs.assignments(tenantId, query.vehicleId),
      query.occurredAt,
    );
    const found = await Promise.all(
      inForce.map((assignment) => this.refs.driver(tenantId, assignment.employeeId)),
    );
    const drivers = new Map(
      found.flatMap((driver) => (driver ? [[driver.id, driver] as const] : [])),
    );
    const policies = candidatesOn(
      await this.refs.policyRevisions(tenantId, query.vehicleId),
      dayInZone(new Date(query.occurredAt), zone),
    );
    return {
      drivers: driverSuggestions(inForce, drivers),
      policies,
      coverageStatus:
        policies.length === 0 ? 'none' : policies.length === 1 ? 'covered' : 'multiple',
    };
  }

  private async replay(
    tenantId: string,
    actor: IncidentActor,
    key: string,
    hash: string,
  ): Promise<Incident | null> {
    const record = await this.store.idempotency(tenantId, actor.id, 'create', key);
    if (!record || record.expiresAt <= this.now().toISOString()) return null;
    if (record.payloadHash !== hash) throw new IncidentError('idempotency_conflict');
    return record.response;
  }

  public async create(
    tenantId: string,
    actor: IncidentActor,
    input: unknown,
    idempotencyKey?: string,
  ): Promise<Incident> {
    if (!canCreate(actor)) throw new IncidentError('forbidden');
    const changes = parseCreate(input);
    if (idempotencyKey !== undefined && !IDEMPOTENCY_KEY.test(idempotencyKey))
      throw new IncidentError('invalid_input', [{ field: 'idempotencyKey', code: 'invalid' }]);
    const hash = payloadHash('new', 'create', changes);
    if (idempotencyKey !== undefined) {
      const replayed = await this.replay(tenantId, actor, idempotencyKey, hash);
      if (replayed) return replayed;
    }
    const vehicle = await this.refs.vehicle(tenantId, changes.vehicleId as string);
    if (!vehicle) throw new IncidentError('not_found');
    await requireDriver(this.refs, tenantId, changes.driverId);
    const zone = await this.refs.timeZone(tenantId);
    const now = this.now();
    const time = now.toISOString();
    const occurredAt = changes.occurredAt ?? null;
    const occurredOn = occurredAt
      ? assertEventTime(occurredAt, vehicle.registeredOn, now, zone)
      : null;
    const coverage = resolveCoverage({
      day: occurredOn,
      revisions: await this.refs.policyRevisions(tenantId, vehicle.id),
      chosenPolicyId: changes.policyId,
      previous: null,
    });
    const id = this.newId();
    const incident = newIncident({
      id,
      tenantId,
      actor,
      time,
      vehicle,
      changes,
      occurredAt,
      occurredOn,
      coverage,
    });
    const claim: IdempotencyClaim | undefined =
      idempotencyKey === undefined
        ? undefined
        : {
            actorId: actor.id,
            command: 'create',
            key: idempotencyKey,
            incidentId: id,
            payloadHash: hash,
            createdAt: time,
            expiresAt: new Date(now.getTime() + this.ttl).toISOString(),
          };
    const result = await this.store.apply({
      incident,
      expectedVersion: null,
      folioYear: folioYear(now, zone),
      transitions: this.timeline(
        actor,
        time,
        'create',
        null,
        'draft',
        Object.keys(changes),
        null,
        coverage.status === 'none',
      ),
      auditActions: this.auditActions('incident.created', coverage.status === 'none'),
      events: [
        {
          type: INCIDENT_CREATED_EVENT,
          payload: { incidentId: id, vehicleId: vehicle.id, version: 1 },
        },
      ],
      ...(claim ? { idempotency: claim } : {}),
    });
    if (result.applied) return result.incident;
    // A concurrent twin won the key: answer with its response, or report the clash.
    const twin =
      idempotencyKey === undefined
        ? null
        : await this.replay(tenantId, actor, idempotencyKey, hash);
    if (twin) return twin;
    throw new IncidentError('duplicate');
  }

  private auditActions(action: string, none: boolean): readonly string[] {
    return none ? [action, 'incident.coverage_none'] : [action];
  }

  private timeline(
    actor: IncidentActor,
    time: string,
    command: string,
    from: Incident['status'] | null,
    to: Incident['status'],
    changed: readonly string[],
    before: TimelineBefore | null,
    coverageNone: boolean,
  ): readonly NewIncidentTransition[] {
    const entry = (name: string, fields: readonly string[], prior: TimelineBefore | null) => ({
      command: name,
      from,
      to,
      actorId: actor.id,
      comment: null,
      occurredAt: time,
      changedFields: [...fields].sort(),
      before: prior,
    });
    return [
      entry(command, changed, before),
      ...(coverageNone ? [entry('coverage_none', ['coverageStatus'], null)] : []),
    ];
  }

  public async update(
    tenantId: string,
    actor: IncidentActor,
    id: string,
    input: unknown,
  ): Promise<Incident> {
    const incident = await this.visible(tenantId, actor, id);
    if (!canEdit(actor, incident)) throw new IncidentError('forbidden');
    const { version, changes } = parseUpdate(input);
    const keys = Object.keys(changes);
    assertEditable(incident.status, keys);
    if (incident.version !== version) throw new IncidentError('stale_version');
    const changed = keys.filter(
      (key) =>
        JSON.stringify(currentValue(incident, key)) !==
        JSON.stringify((changes as Record<string, unknown>)[key]),
    );
    if (changed.length === 0) return incident;
    const next = await mergeChanges(this.refs, this.now(), tenantId, incident, changes, changed);
    const now = this.now().toISOString();
    const updated: Incident = {
      ...next.incident,
      version: incident.version + 1,
      updatedAt: now,
      updatedBy: actor.id,
    };
    const becameNone = updated.coverageStatus === 'none' && incident.coverageStatus !== 'none';
    const result = await this.store.apply({
      incident: updated,
      expectedVersion: incident.version,
      folioYear: null,
      transitions: this.timeline(
        actor,
        now,
        'update',
        incident.status,
        incident.status,
        next.changed,
        beforeOf(incident),
        becameNone,
      ),
      auditActions: this.auditActions('incident.updated', becameNone),
      events: [
        {
          type: INCIDENT_UPDATED_EVENT,
          payload: { incidentId: incident.id, version: updated.version },
        },
      ],
    });
    if (!result.applied) throw new IncidentError('stale_version');
    return result.incident;
  }
}
