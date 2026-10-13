import { validateIncidentEvent } from './events.js';
import { formatFolio } from './folio.js';
import type { IdempotencyRecord } from './idempotency.js';
import type { IncidentStore } from './ports.js';
import { SEVERITY_RANK } from './catalog.js';
import type {
  Incident,
  IncidentApplyResult,
  IncidentEvent,
  IncidentExtraWrite,
  IncidentListQuery,
  IncidentMutation,
  IncidentPage,
  IncidentTransition,
} from './types.js';

const key = (tenantId: string, id: string) => `${tenantId.length}:${tenantId}${id}`;
const claimKey = (tenantId: string, actorId: string, command: string, k: string) =>
  JSON.stringify([tenantId, actorId, command, k]);

const SORT_VALUE: Readonly<Record<IncidentListQuery['sort'], (incident: Incident) => string>> = {
  occurredAt: (incident) => incident.occurredAt ?? '',
  createdAt: (incident) => incident.createdAt,
  severity: (incident) => String(SEVERITY_RANK[incident.severity ?? 'none']).padStart(2, '0'),
  folio: (incident) => incident.folio,
};

/** In-memory store for unit tests and the non-persistent composition; same CAS semantics as MySQL. */
export class InMemoryIncidentStore implements IncidentStore {
  private readonly incidents = new Map<string, Incident>();
  private readonly timelines = new Map<string, IncidentTransition[]>();
  private readonly keys = new Map<string, IdempotencyRecord>();
  private readonly folios = new Map<string, number>();
  public readonly events: { readonly tenantId: string; readonly event: IncidentEvent }[] = [];
  public readonly audit: { readonly tenantId: string; readonly action: string }[] = [];

  /** Mutations run one after the other, so the version check and the commit are never interleaved. */
  private tail: Promise<unknown> = Promise.resolve();

  public apply(
    mutation: IncidentMutation,
    extra?: IncidentExtraWrite,
  ): Promise<IncidentApplyResult> {
    const run = this.tail.then(() => this.applyNow(mutation, extra));
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async applyNow(
    mutation: IncidentMutation,
    extra?: IncidentExtraWrite,
  ): Promise<IncidentApplyResult> {
    const events = mutation.events.map(validateIncidentEvent);
    const { tenantId } = mutation.incident;
    const k = key(tenantId, mutation.incident.id);
    const current = this.incidents.get(k);
    if (mutation.expectedVersion === null ? current : current?.version !== mutation.expectedVersion)
      return { applied: false };
    const claim = mutation.idempotency;
    const ck = claim ? claimKey(tenantId, claim.actorId, claim.command, claim.key) : null;
    if (claim && ck) {
      const taken = this.keys.get(ck);
      if (taken && taken.expiresAt > claim.createdAt) return { applied: false };
    }
    // The extra write goes before anything is committed here: if it refuses, nothing is kept.
    if (extra && !(await extra.run(undefined))) return { applied: false };
    let incident = structuredClone(mutation.incident);
    if (mutation.expectedVersion === null && mutation.folioYear !== null) {
      const sequenceKey = `${tenantId.length}:${tenantId}${mutation.folioYear}`;
      const next = (this.folios.get(sequenceKey) ?? 0) + 1;
      this.folios.set(sequenceKey, next);
      incident = { ...incident, folio: formatFolio(mutation.folioYear, next) };
    }
    this.incidents.set(k, incident);
    const timeline = this.timelines.get(k) ?? [];
    for (const entry of mutation.transitions)
      timeline.push({
        ...structuredClone(entry),
        tenantId,
        incidentId: incident.id,
        sequence: timeline.length + 1,
      });
    this.timelines.set(k, timeline);
    if (claim && ck)
      this.keys.set(ck, {
        ...claim,
        tenantId,
        status: 'completed',
        response: structuredClone(incident),
      });
    for (const action of mutation.auditActions) this.audit.push({ tenantId, action });
    for (const event of events) this.events.push({ tenantId, event });
    return { applied: true, incident: structuredClone(incident) };
  }

  public async get(tenantId: string, id: string): Promise<Incident | null> {
    const incident = this.incidents.get(key(tenantId, id));
    return incident ? structuredClone(incident) : null;
  }

  public async list(tenantId: string, query: IncidentListQuery): Promise<IncidentPage> {
    const { filter } = query;
    const matching = [...this.incidents.values()].filter(
      (i) =>
        i.tenantId === tenantId &&
        (!filter.statuses || filter.statuses.includes(i.status)) &&
        (!filter.severity || i.severity === filter.severity) &&
        (!filter.type || i.type === filter.type) &&
        (!filter.vehicleId || i.vehicleId === filter.vehicleId) &&
        (!filter.responsibleId || i.responsibleId === filter.responsibleId) &&
        (!filter.createdBy || i.createdBy === filter.createdBy) &&
        (!filter.occurredFrom || (i.occurredOn !== null && i.occurredOn >= filter.occurredFrom)) &&
        (!filter.occurredTo || (i.occurredOn !== null && i.occurredOn <= filter.occurredTo)),
    );
    const sign = query.direction === 'asc' ? 1 : -1;
    const value = SORT_VALUE[query.sort];
    matching.sort(
      (a, b) => sign * value(a).localeCompare(value(b)) || sign * a.id.localeCompare(b.id),
    );
    return {
      items: matching
        .slice(query.offset, query.offset + query.limit)
        .map((i) => structuredClone(i)),
      total: matching.length,
    };
  }

  public async history(tenantId: string, id: string): Promise<readonly IncidentTransition[]> {
    return structuredClone(this.timelines.get(key(tenantId, id)) ?? []);
  }

  public async idempotency(
    tenantId: string,
    actorId: string,
    command: string,
    k: string,
  ): Promise<IdempotencyRecord | null> {
    const record = this.keys.get(claimKey(tenantId, actorId, command, k));
    return record ? structuredClone(record) : null;
  }
}
