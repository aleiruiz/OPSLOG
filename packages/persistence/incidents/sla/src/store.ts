import 'reflect-metadata';
import { In, type DataSource, type EntityManager } from 'typeorm';
import { MySqlTenantOutboxStore } from '../../../audit/src/index.js';
import {
  alertEventOf,
  alertIdOf,
  INCIDENT_SLA_SCAN_EVENT,
  isOpaqueId,
  kindsWhere,
  parseSlaAlertPayload,
  type AlertFilter,
  type AlertKind,
  type AlertWindow,
  type ClaimResult,
  type CycleRow,
  type DeliveryKey,
  type DeliveryRow,
  type IncidentSlaStore,
  type SlaScanJob,
  type NewAlert,
  type Settlement,
  type SlaAlert,
  type Viewer,
} from '../../../../domain/incidents/sla/src/index.js';
import type { IncidentSeverity } from '../../../../domain/incidents/cases/src/index.js';
import type { OutboxTransaction } from '../../../../platform/outbox/src/index.js';
import { INCIDENT_RUNTIME_ACCOUNT } from '../../cases/src/data-source.js';
import { INCIDENT_TABLES } from '../../cases/src/entities.js';
import {
  INCIDENT_SLA_TABLES as T,
  IncidentSlaAlertSchema,
  IncidentSlaCycleSchema,
  IncidentSlaDeliverySchema,
  type IncidentSlaAlertEntity,
  type IncidentSlaCycleEntity,
} from './entities.js';

/** Where the notice's event is written; the tenant outbox, unless a test injects its own. */
export interface SlaOutbox {
  transaction<R>(manager: unknown, work: (tx: OutboxTransaction) => R | Promise<R>): Promise<R>;
}
export const SLA_EVENT_ACTOR = 'system:incident-sla';

const cycleRow = (row: CycleRow): IncidentSlaCycleEntity => ({
  tenantId: row.tenantId,
  incidentId: row.incidentId,
  cycle: row.cycle,
  startedAt: new Date(row.startedAt),
  severity: row.severity,
  targetDays: row.targetDays,
  targetVersion: row.targetVersion,
});
const cycleFrom = (row: IncidentSlaCycleEntity): CycleRow => ({
  tenantId: row.tenantId,
  incidentId: row.incidentId,
  cycle: Number(row.cycle),
  startedAt: row.startedAt.toISOString(),
  severity: row.severity as IncidentSeverity,
  targetDays: Number(row.targetDays),
  targetVersion: Number(row.targetVersion),
});
const alertRow = (id: string, alert: NewAlert): IncidentSlaAlertEntity => ({
  tenantId: alert.tenantId,
  id,
  incidentId: alert.incidentId,
  folio: alert.folio,
  cycle: alert.cycle,
  kind: alert.kind,
  dedupeRef: alert.dedupeRef,
  severity: alert.severity,
  deadlineAt: alert.deadline === null ? null : new Date(alert.deadline),
  subjectId: alert.subjectId,
  createdAt: new Date(alert.createdAt),
});
const alertFrom = (row: IncidentSlaAlertEntity): SlaAlert => ({
  tenantId: row.tenantId,
  id: row.id,
  incidentId: row.incidentId,
  folio: row.folio,
  cycle: Number(row.cycle),
  kind: row.kind as AlertKind,
  dedupeRef: row.dedupeRef,
  severity: row.severity as IncidentSeverity | null,
  deadline: row.deadlineAt === null ? null : row.deadlineAt.toISOString(),
  subjectId: row.subjectId,
  createdAt: row.createdAt.toISOString(),
});
const isDuplicate = (error: unknown) => (error as { code?: string }).code === 'ER_DUP_ENTRY';
class AlreadyExists extends Error {}

/** SQL for "the member may see this notice", the same rule as `visibleTo` of the domain. */
function visibility(viewer: Viewer): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  const marks = (kinds: readonly AlertKind[]) => {
    params.push(...kinds);
    return kinds.map(() => '?').join(',');
  };
  const assignee = kindsWhere((a) => a.assignee);
  if (assignee.length) {
    parts.push(`(a.kind IN (${marks(assignee)}) AND a.subject_id = ? AND i.responsible_id = ?)`);
    params.push(viewer.id, viewer.id);
  }
  const responsible = kindsWhere((a) => a.responsible);
  if (responsible.length) {
    parts.push(
      `(a.kind IN (${marks(responsible)}) AND (i.responsible_id = ?${viewer.edit ? ' OR i.responsible_id IS NULL' : ''}))`,
    );
    params.push(viewer.id);
  }
  const edit = kindsWhere((a) => a.edit);
  if (viewer.edit && edit.length) parts.push(`a.kind IN (${marks(edit)})`);
  const approve = kindsWhere((a) => a.approve);
  if (viewer.approve && approve.length) parts.push(`a.kind IN (${marks(approve)})`);
  return { sql: parts.length ? `(${parts.join(' OR ')})` : '1 = 0', params };
}

/**
 * SLA of the incidents on MySQL. Every selector carries the tenant. A notice and its outbox event
 * commit together; a delivery is claimed with a lease under a row lock, so two workers never send
 * the same message at once.
 */
export class TypeOrmIncidentSlaStore implements IncidentSlaStore {
  private readonly outbox: SlaOutbox;
  public constructor(
    private readonly dataSource: DataSource,
    outbox?: SlaOutbox,
  ) {
    if (dataSource.options.type !== 'mysql' || dataSource.options.synchronize === true)
      throw new Error('Incident SLA store requires MySQL with synchronize disabled');
    if (
      typeof dataSource.options.username !== 'string' ||
      !INCIDENT_RUNTIME_ACCOUNT.test(dataSource.options.username)
    )
      throw new Error('Incident SLA store requires the restricted incidents runtime account');
    this.outbox =
      outbox ??
      new MySqlTenantOutboxStore(
        () => [],
        () => this.dataSource,
        () => this.dataSource,
      );
  }

  public async enqueueScan(job: SlaScanJob): Promise<void> {
    if (!isOpaqueId(job.jobId) || (job.incidentId !== undefined && !isOpaqueId(job.incidentId)))
      throw new Error('invalid incident SLA scan job');
    await this.dataSource.transaction('READ COMMITTED', (manager) =>
      this.outbox.transaction(manager, (tx) => {
        const eventId = `scan-${job.jobId}`;
        tx.enqueue({
          eventId,
          tenantId: job.tenantId,
          type: INCIDENT_SLA_SCAN_EVENT,
          payload: job.incidentId === undefined ? {} : { incidentId: job.incidentId },
          occurredAt: job.at,
          idempotencyKey: eventId,
          correlationId: `${job.incidentId ?? job.tenantId}.sla-scan`,
          actorRef: { subject: SLA_EVENT_ACTOR, kind: 'system' },
          entityId: job.incidentId ?? job.tenantId,
          schemaVersion: 1,
        });
      }),
    );
  }

  public async cycles(tenantId: string, incidentIds: readonly string[]): Promise<CycleRow[]> {
    if (incidentIds.length === 0) return [];
    const rows = await this.dataSource
      .getRepository(IncidentSlaCycleSchema)
      .find({ where: { tenantId, incidentId: In([...incidentIds]) } });
    return rows.map(cycleFrom);
  }

  public async openCycle(row: CycleRow): Promise<void> {
    try {
      await this.dataSource.getRepository(IncidentSlaCycleSchema).insert(cycleRow(row));
    } catch (error) {
      if (!isDuplicate(error)) throw error;
    }
  }

  public async retarget(row: CycleRow, expectedTargetVersion: number): Promise<boolean> {
    const changed = await this.dataSource.getRepository(IncidentSlaCycleSchema).update(
      {
        tenantId: row.tenantId,
        incidentId: row.incidentId,
        cycle: row.cycle,
        targetVersion: expectedTargetVersion,
      },
      {
        startedAt: new Date(row.startedAt),
        severity: row.severity,
        targetDays: row.targetDays,
        targetVersion: row.targetVersion,
      },
    );
    return changed.affected === 1;
  }

  public async alertKeys(tenantId: string, incidentIds: readonly string[]): Promise<Set<string>> {
    if (incidentIds.length === 0) return new Set();
    const rows = await this.dataSource.getRepository(IncidentSlaAlertSchema).find({
      select: { incidentId: true, cycle: true, kind: true, dedupeRef: true },
      where: { tenantId, incidentId: In([...incidentIds]) },
    });
    return new Set(rows.map((r) => `${r.incidentId}|${Number(r.cycle)}|${r.kind}|${r.dedupeRef}`));
  }

  public async createAlert(alert: NewAlert): Promise<SlaAlert | null> {
    const id = alertIdOf(alert);
    const saved: SlaAlert = { ...alert, id };
    const event = alertEventOf(saved);
    parseSlaAlertPayload(event.payload);
    try {
      await this.dataSource.transaction('READ COMMITTED', async (manager) => {
        try {
          await manager.getRepository(IncidentSlaAlertSchema).insert(alertRow(id, alert));
        } catch (error) {
          if (isDuplicate(error)) throw new AlreadyExists();
          throw error;
        }
        await this.outbox.transaction(manager, (tx) => {
          const eventId = `evt-${id}`;
          tx.enqueue({
            eventId,
            tenantId: alert.tenantId,
            type: event.type,
            payload: event.payload,
            occurredAt: alert.createdAt,
            idempotencyKey: eventId,
            correlationId: `${alert.incidentId}.sla`,
            actorRef: { subject: SLA_EVENT_ACTOR, kind: 'system' },
            entityId: alert.incidentId,
            schemaVersion: 1,
          });
        });
      });
    } catch (error) {
      if (error instanceof AlreadyExists) return null;
      throw error;
    }
    return saved;
  }

  public async alert(tenantId: string, alertId: string): Promise<SlaAlert | null> {
    const row = await this.dataSource
      .getRepository(IncidentSlaAlertSchema)
      .findOneBy({ tenantId, id: alertId });
    return row ? alertFrom(row) : null;
  }

  public async listAlerts(
    tenantId: string,
    viewer: Viewer,
    filter: AlertFilter,
    window: AlertWindow,
  ): Promise<{ rows: SlaAlert[]; total: number }> {
    const see = visibility(viewer);
    const where = [`a.company_id = ?`, see.sql];
    const params: unknown[] = [tenantId, ...see.params];
    if (filter.kind) {
      where.push('a.kind = ?');
      params.push(filter.kind);
    }
    if (filter.incidentId) {
      where.push('a.incident_id = ?');
      params.push(filter.incidentId);
    }
    const from = `FROM \`${T.alerts}\` a JOIN \`${INCIDENT_TABLES.incidents}\` i
      ON i.company_id = a.company_id AND i.id = a.incident_id WHERE ${where.join(' AND ')}`;
    const [count] = (await this.dataSource.query(`SELECT COUNT(*) AS n ${from}`, params)) as {
      n: string | number;
    }[];
    const limit = Number(window.limit);
    const offset = Number(window.offset);
    const found = (await this.dataSource.query(
      `SELECT a.company_id AS tenantId, a.id, a.incident_id AS incidentId, a.folio, a.cycle, a.kind,
        a.dedupe_ref AS dedupeRef, a.severity, a.deadline_at AS deadlineAt, a.subject_id AS subjectId,
        a.created_at AS createdAt ${from} ORDER BY a.created_at DESC, a.id DESC LIMIT ${limit} OFFSET ${offset}`,
      params,
    )) as IncidentSlaAlertEntity[];
    return { rows: found.map(alertFrom), total: Number(count?.n ?? 0) };
  }

  private where = (key: DeliveryKey) => ({
    tenantId: key.tenantId,
    alertId: key.alertId,
    recipientId: key.recipientId,
    channel: key.channel,
  });

  public async claimDelivery(key: DeliveryKey, now: string, leaseMs: number): Promise<ClaimResult> {
    const at = new Date(now);
    return this.dataSource.transaction('READ COMMITTED', async (manager: EntityManager) => {
      const rows = manager.getRepository(IncidentSlaDeliverySchema);
      // The upsert takes the row lock at once, so two workers queue instead of deadlocking.
      await manager.query(
        `INSERT INTO \`${T.deliveries}\` (company_id, alert_id, recipient_id, channel, status, attempts)
         VALUES (?, ?, ?, ?, 'pending', 0) ON DUPLICATE KEY UPDATE company_id = company_id`,
        [key.tenantId, key.alertId, key.recipientId, key.channel],
      );
      const row = await rows
        .createQueryBuilder('d')
        .setLock('pessimistic_write')
        .where(this.where(key))
        .getOne();
      if (!row || row.status !== 'pending') return { result: 'done' } as const;
      if (row.leaseUntil !== null && row.leaseUntil.getTime() > at.getTime())
        return { result: 'busy' } as const;
      const attempt = Number(row.attempts) + 1;
      await rows.update(this.where(key), {
        attempts: attempt,
        leaseUntil: new Date(at.getTime() + leaseMs),
      });
      return { result: 'claimed', attempt } as const;
    });
  }

  public async settleDelivery(
    key: DeliveryKey,
    attempt: number,
    settlement: Settlement,
  ): Promise<void> {
    const change =
      settlement.status === 'retry'
        ? { nextAttemptAt: new Date(settlement.nextAttemptAt), leaseUntil: null }
        : { status: settlement.status, nextAttemptAt: null, leaseUntil: null };
    await this.dataSource
      .getRepository(IncidentSlaDeliverySchema)
      .update({ ...this.where(key), status: 'pending', attempts: attempt }, change);
  }

  public async skipDelivery(key: DeliveryKey): Promise<void> {
    await this.dataSource.transaction('READ COMMITTED', async (manager) => {
      const rows = manager.getRepository(IncidentSlaDeliverySchema);
      try {
        await rows.insert({
          ...this.where(key),
          status: 'skipped',
          attempts: 0,
          nextAttemptAt: null,
          leaseUntil: null,
        });
      } catch (error) {
        if (!isDuplicate(error)) throw error;
        // A `sent` or `failed` row stays as it is; only a pending one becomes skipped.
        await rows.update(
          { ...this.where(key), status: 'pending' },
          { status: 'skipped', nextAttemptAt: null, leaseUntil: null },
        );
      }
    });
  }

  public async deliveries(tenantId: string, alertId: string): Promise<DeliveryRow[]> {
    const rows = await this.dataSource
      .getRepository(IncidentSlaDeliverySchema)
      .find({ where: { tenantId, alertId }, order: { recipientId: 'ASC', channel: 'ASC' } });
    return rows.map((row) => ({
      tenantId: row.tenantId,
      alertId: row.alertId,
      recipientId: row.recipientId,
      channel: row.channel as DeliveryRow['channel'],
      status: row.status as DeliveryRow['status'],
      attempts: Number(row.attempts),
      nextAttemptAt: row.nextAttemptAt === null ? null : row.nextAttemptAt.toISOString(),
    }));
  }
}
