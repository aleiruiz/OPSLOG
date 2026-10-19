import 'reflect-metadata';
import { createHash } from 'node:crypto';
import {
  And,
  In,
  LessThan,
  LessThanOrEqual,
  MoreThan,
  MoreThanOrEqual,
  Not,
  type DataSource,
  type EntityManager,
  type FindOptionsWhere,
} from 'typeorm';
import { appendLocalAuditAndDelivery, MySqlTenantOutboxStore } from '../../../audit/src/index.js';
import {
  formatFolio,
  TERMINAL_STATUSES,
  validateIncidentEvent,
  type IdempotencyRecord,
  type Incident,
  type IncidentAnalyticsReads,
  type IncidentApplyResult,
  type IncidentExtraWrite,
  type IncidentListQuery,
  type IncidentMutation,
  type IncidentPage,
  type IncidentStore,
  type IncidentTimelineRow,
  type IncidentTransition,
} from '../../../../domain/incidents/cases/src/index.js';
import { INCIDENT_RUNTIME_ACCOUNT } from './data-source.js';
import {
  type IncidentEntity,
  IncidentFolioSchema,
  IncidentIdempotencySchema,
  IncidentSchema,
  IncidentTransitionSchema,
} from './entities.js';
import { listPage } from './list.js';
import {
  idempotencyFrom,
  idempotencyRow,
  incidentFrom,
  incidentRow,
  transitionFrom,
  transitionRow,
} from './mapping.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);
const FOLIO_KIND = 'incident';

/** Thrown inside the transaction to roll it back when an extra write refuses (a uniqueness conflict). */
class ExtraWriteRefused extends Error {}

/**
 * Tenant is part of every selector. Each mutation commits the incident (version CAS), the folio
 * counter, the timeline, the local audit rows and the allowlisted outbox events in one transaction.
 */
export class TypeOrmIncidentStore implements IncidentStore, IncidentAnalyticsReads {
  private readonly outbox: MySqlTenantOutboxStore;
  public constructor(
    private readonly dataSource: DataSource,
    private readonly maxAttempts = 5,
  ) {
    if (dataSource.options.type !== 'mysql' || dataSource.options.synchronize === true)
      throw new Error('Incident store requires MySQL with synchronize disabled');
    if (
      typeof dataSource.options.username !== 'string' ||
      !INCIDENT_RUNTIME_ACCOUNT.test(dataSource.options.username)
    )
      throw new Error('Incident store requires the restricted incidents runtime account');
    this.outbox = new MySqlTenantOutboxStore(
      () => [],
      () => this.dataSource,
      () => this.dataSource,
    );
  }

  private async transaction<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.dataSource.transaction('READ COMMITTED', work);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (
          attempt < this.maxAttempts &&
          (code === 'ER_LOCK_DEADLOCK' || code === 'ER_LOCK_WAIT_TIMEOUT')
        ) {
          // Back off a little so the competing transactions do not collide again.
          await new Promise((resolve) => setTimeout(resolve, attempt * 10 + Math.random() * 20));
          continue;
        }
        throw error;
      }
    }
  }

  /** Takes the next folio of the tenant and year under a row lock, so concurrent creations queue (BR-024). */
  private async nextFolio(manager: EntityManager, tenantId: string, year: number): Promise<string> {
    const counters = manager.getRepository(IncidentFolioSchema);
    const where = { tenantId, year, kind: FOLIO_KIND };
    const lock = { mode: 'pessimistic_write' } as const;
    // Lock first: INSERT IGNORE on an existing row takes a shared lock and invites deadlocks.
    let row = await counters.findOne({ where, lock });
    if (!row) {
      await counters
        .createQueryBuilder()
        .insert()
        .orIgnore()
        .values({ ...where, lastValue: 0 })
        .execute();
      row = await counters.findOne({ where, lock });
    }
    const next = (row?.lastValue ?? 0) + 1;
    await counters.update(where, { lastValue: next });
    return formatFolio(year, next);
  }

  public async apply(
    mutation: IncidentMutation,
    extra?: IncidentExtraWrite,
  ): Promise<IncidentApplyResult> {
    const events = mutation.events.map(validateIncidentEvent);
    const { tenantId } = mutation.incident;
    try {
      return await this.transaction(async (manager): Promise<IncidentApplyResult> => {
        let incident = mutation.incident;
        const incidents = manager.getRepository(IncidentSchema);
        if (mutation.expectedVersion === null) {
          if (mutation.folioYear !== null)
            incident = {
              ...incident,
              folio: await this.nextFolio(manager, tenantId, mutation.folioYear),
            };
          await incidents.insert(incidentRow(incident));
        } else {
          const changed = await incidents.update(
            { tenantId, id: incident.id, version: mutation.expectedVersion },
            incidentRow(incident),
          );
          if (changed.affected !== 1) return { applied: false };
        }
        // The case row is written (and its version taken) before the children that depend on it.
        if (extra && !(await extra.run(manager))) throw new ExtraWriteRefused();
        await this.writeTimeline(manager, incident, mutation);
        for (const action of mutation.auditActions)
          await appendLocalAuditAndDelivery(manager, {
            eventId: `${incident.id}.${digest(`${action}|${incident.version}`)}`,
            tenantId,
            action,
            entityType: 'incident',
            entityId: incident.id,
            occurredAt: incident.updatedAt,
            actor: { id: incident.updatedBy, kind: 'user' },
            correlationId: `${incident.id}.v${incident.version}`,
            data: { attempts: 1 },
          });
        if (mutation.idempotency) {
          const registry = manager.getRepository(IncidentIdempotencySchema);
          const { actorId, command, key, createdAt } = mutation.idempotency;
          // An expired key of the same tuple is a new command; a live one trips the primary key.
          await registry.delete({
            tenantId,
            actorId,
            command,
            key,
            expiresAt: LessThanOrEqual(new Date(createdAt)),
          });
          await registry.insert(idempotencyRow(tenantId, mutation.idempotency, incident));
        }
        if (events.length)
          await this.outbox.transaction(manager, (tx) =>
            events.forEach((event, index) => {
              const eventId = `inc-${digest(`${tenantId}|${incident.id}|${incident.version}|${index}`)}`;
              tx.enqueue({
                eventId,
                tenantId,
                type: event.type,
                payload: event.payload,
                occurredAt: incident.updatedAt,
                idempotencyKey: eventId,
                correlationId: `${incident.id}.v${incident.version}`,
                actorRef: { subject: incident.updatedBy, kind: 'user' },
                requiredPermission: 'incidents:view',
                entityId: incident.id,
                schemaVersion: 1,
              });
            }),
          );
        return { applied: true, incident };
      });
    } catch (error) {
      if (error instanceof ExtraWriteRefused) return { applied: false };
      // A duplicate key is a lost creation race, a live idempotency key or a file linked twice:
      // nothing was written.
      if ((error as { code?: string }).code === 'ER_DUP_ENTRY') return { applied: false };
      throw error;
    }
  }

  private async writeTimeline(
    manager: EntityManager,
    incident: Incident,
    mutation: IncidentMutation,
  ): Promise<void> {
    if (mutation.transitions.length === 0) return;
    const repository = manager.getRepository(IncidentTransitionSchema);
    const last = await repository
      .createQueryBuilder('t')
      .select('MAX(t.sequence)', 'last')
      .where('t.tenantId = :tenantId AND t.incidentId = :id', {
        tenantId: incident.tenantId,
        id: incident.id,
      })
      .getRawOne<{ last: string | null }>();
    let sequence = Number(last?.last ?? 0);
    for (const entry of mutation.transitions)
      await repository.insert(
        transitionRow(incident.tenantId, incident.id, (sequence += 1), entry),
      );
  }

  public async get(tenantId: string, id: string): Promise<Incident | null> {
    const row = await this.dataSource.getRepository(IncidentSchema).findOneBy({ tenantId, id });
    return row ? incidentFrom(row) : null;
  }

  public list(tenantId: string, query: IncidentListQuery): Promise<IncidentPage> {
    return listPage(this.dataSource.getRepository(IncidentSchema), tenantId, query);
  }

  public async analyticsOpenCases(
    tenantId: string,
    areaIds: readonly string[] | null,
  ): Promise<readonly Incident[]> {
    if (areaIds?.length === 0) return [];
    const rows = await this.dataSource.getRepository(IncidentSchema).find({
      where: {
        tenantId,
        status: And(Not('draft'), ...TERMINAL_STATUSES.map((status) => Not(status))),
        ...(areaIds ? { areaId: In([...areaIds]) } : {}),
      },
      order: { id: 'ASC' },
    });
    return rows.map(incidentFrom);
  }

  /**
   * Cases reported, first resolved or closed in `[from, to)`. A case in its first cycle resolved when
   * `resolved_at` says so; a reopened one keeps its first `resolve` entry on the timeline.
   */
  public async analyticsTimeline(
    tenantId: string,
    areaIds: readonly string[] | null,
    window: { readonly from: string; readonly to: string },
  ): Promise<readonly IncidentTimelineRow[]> {
    if (areaIds?.length === 0) return [];
    const range = And(MoreThanOrEqual(new Date(window.from)), LessThan(new Date(window.to)));
    const base: FindOptionsWhere<IncidentEntity> = {
      tenantId,
      ...(areaIds ? { areaId: In([...areaIds]) } : {}),
    };
    const rows = await this.dataSource.getRepository(IncidentSchema).find({
      select: { id: true, cycle: true, reportedAt: true, resolvedAt: true, closedAt: true },
      where: [
        { ...base, reportedAt: range },
        { ...base, closedAt: range },
        { ...base, cycle: 1, resolvedAt: range },
        { ...base, cycle: MoreThan(1) },
      ],
    });
    const first = new Map<string, Date>();
    const reopened = rows.filter((row) => row.cycle > 1).map((row) => row.id);
    for (let at = 0; at < reopened.length; at += 500) {
      const entries = await this.dataSource.getRepository(IncidentTransitionSchema).find({
        select: { incidentId: true, sequence: true, occurredAt: true },
        where: { tenantId, command: 'resolve', incidentId: In(reopened.slice(at, at + 500)) },
        order: { incidentId: 'ASC', sequence: 'ASC' },
      });
      for (const entry of entries)
        if (!first.has(entry.incidentId)) first.set(entry.incidentId, entry.occurredAt);
    }
    const inside = (instant: Date | null | undefined): instant is Date =>
      instant !== null &&
      instant !== undefined &&
      instant.getTime() >= Date.parse(window.from) &&
      instant.getTime() < Date.parse(window.to);
    const result: IncidentTimelineRow[] = [];
    for (const row of rows) {
      const firstResolved = row.cycle > 1 ? (first.get(row.id) ?? null) : row.resolvedAt;
      if (!inside(row.reportedAt) && !inside(firstResolved) && !inside(row.closedAt)) continue;
      result.push({
        reportedAt: row.reportedAt?.toISOString() ?? null,
        firstResolvedAt: firstResolved?.toISOString() ?? null,
        closedAt: row.closedAt?.toISOString() ?? null,
      });
    }
    return result;
  }

  public async history(tenantId: string, id: string): Promise<readonly IncidentTransition[]> {
    const rows = await this.dataSource
      .getRepository(IncidentTransitionSchema)
      .find({ where: { tenantId, incidentId: id }, order: { sequence: 'ASC' } });
    return rows.map(transitionFrom);
  }

  public async idempotency(
    tenantId: string,
    actorId: string,
    command: string,
    key: string,
  ): Promise<IdempotencyRecord | null> {
    const row = await this.dataSource
      .getRepository(IncidentIdempotencySchema)
      .findOneBy({ tenantId, actorId, command, key });
    return row ? idempotencyFrom(row) : null;
  }
}
