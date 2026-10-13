import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { LessThanOrEqual, type DataSource, type EntityManager } from 'typeorm';
import { appendLocalAuditAndDelivery, MySqlTenantOutboxStore } from '../../../audit/src/index.js';
import {
  formatFolio,
  validateIncidentEvent,
  type IdempotencyRecord,
  type Incident,
  type IncidentApplyResult,
  type IncidentListQuery,
  type IncidentMutation,
  type IncidentPage,
  type IncidentStore,
  type IncidentTransition,
} from '../../../../domain/incidents/cases/src/index.js';
import { INCIDENT_RUNTIME_ACCOUNT } from './data-source.js';
import {
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

/**
 * Tenant is part of every selector. Each mutation commits the incident (version CAS), the folio
 * counter, the timeline, the local audit rows and the allowlisted outbox events in one transaction.
 */
export class TypeOrmIncidentStore implements IncidentStore {
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

  public async apply(mutation: IncidentMutation): Promise<IncidentApplyResult> {
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
      // A duplicate key is a lost creation race or a live idempotency key: nothing was written.
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
