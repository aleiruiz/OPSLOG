import 'reflect-metadata';
import type { DataSource, EntityManager } from 'typeorm';
import {
  isEventKind,
  isSubscriptionType,
  type Channel,
  type CompanyRule,
  type DeliveryOutcome,
  type DeliveryWork,
  type EventKind,
  type FailedDelivery,
  type NewDelivery,
  type NewNotification,
  type NotificationFilter,
  type NotificationSlice,
  type NotificationEnvelope,
  type NotificationEvents,
  type NotificationStore,
  type NotificationWindow,
  type Preference,
  type Subscription,
  type SubscriptionType,
} from '../../../domain/notifications/src/index.js';
import { MySqlTenantOutboxStore } from '../../audit/src/index.js';
import type { OutboxTransaction } from '../../../platform/outbox/src/index.js';
import { NOTIFICATION_RUNTIME_ACCOUNT } from './data-source.js';
import { NOTIFICATION_TABLES as T } from './entities.js';
import {
  DUPLICATE_KEY,
  affected,
  center,
  date,
  delivery,
  errno,
  flag,
  iso,
  marks,
  notice,
  outcomeChange,
  type Row,
} from './rows.js';

/** Where the events of `publish` are written: the tenant outbox, unless a test injects its own. */
export interface NotificationOutbox {
  transaction<R>(manager: unknown, work: (tx: OutboxTransaction) => R | Promise<R>): Promise<R>;
}

/** The actor of the events the center writes itself; the worker does not gate system actors by role. */
const SYSTEM_ACTOR = { subject: 'system:notifications', kind: 'system' } as const;

/** TypeORM adapter of the notification center. Every statement names the company; none crosses it. */
export class TypeOrmNotificationStore implements NotificationStore, NotificationEvents {
  private readonly outbox: NotificationOutbox;
  public constructor(
    private readonly dataSource: DataSource,
    outbox?: NotificationOutbox,
  ) {
    const username = (dataSource.options as { username?: string }).username ?? '';
    if (!NOTIFICATION_RUNTIME_ACCOUNT.test(username))
      throw new Error('Notification store requires its restricted runtime account');
    this.outbox =
      outbox ??
      new MySqlTenantOutboxStore(
        () => [],
        () => this.dataSource,
        () => this.dataSource,
      );
  }

  /** Writes the event to the tenant outbox in its own transaction; the same `eventId` writes nothing more. */
  public async publish(event: NotificationEnvelope): Promise<void> {
    await this.dataSource.transaction('READ COMMITTED', (manager) =>
      this.outbox.transaction(manager, (tx) => {
        tx.enqueue({
          eventId: event.eventId,
          tenantId: event.tenantId,
          type: event.type,
          payload: event.payload,
          occurredAt: event.occurredAt,
          idempotencyKey: event.eventId,
          correlationId: event.eventId,
          actorRef: SYSTEM_ACTOR,
          entityId: event.entityId,
          schemaVersion: 1,
        });
      }),
    );
  }

  private run(sql: string, params: readonly unknown[], manager?: EntityManager): Promise<unknown> {
    return (manager ?? this.dataSource).query(sql, [...params]);
  }

  private async rows(sql: string, params: readonly unknown[]): Promise<Row[]> {
    return (await this.run(sql, params)) as Row[];
  }

  public async create(
    notification: NewNotification,
    deliveries: readonly NewDelivery[],
  ): Promise<boolean> {
    return this.dataSource.transaction('READ COMMITTED', async (manager) => {
      try {
        await this.run(
          `INSERT INTO \`${T.notifications}\` (company_id,id,recipient_id,event_kind,entity_type,entity_id,title,link,severity,in_app,date_version,threshold,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            notification.tenantId,
            notification.id,
            notification.recipientId,
            notification.eventKind,
            notification.entityType,
            notification.entityId,
            notification.title,
            notification.link,
            notification.severity,
            notification.inApp ? 1 : 0,
            notification.dateVersion,
            notification.threshold,
            new Date(notification.createdAt),
          ],
          manager,
        );
      } catch (error) {
        if (errno(error) === DUPLICATE_KEY) return false;
        throw error;
      }
      for (const item of deliveries)
        await this.run(
          `INSERT INTO \`${T.deliveries}\` (company_id,notification_id,channel,status,attempts,last_error,next_attempt_at,lease_until,updated_at) VALUES (?,?,?,?,0,NULL,?,NULL,?)`,
          [
            notification.tenantId,
            notification.id,
            item.channel,
            item.status,
            date(item.nextAttemptAt),
            new Date(notification.createdAt),
          ],
          manager,
        );
      return true;
    });
  }

  public async list(
    tenantId: string,
    recipientId: string,
    filter: NotificationFilter,
    window: NotificationWindow,
  ): Promise<NotificationSlice> {
    if (filter.kinds.length === 0) return { items: [], total: 0 };
    const { where, params } = center(tenantId, recipientId, filter);
    const items = await this.rows(
      `SELECT * FROM \`${T.notifications}\` WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      [...params, window.limit, window.offset],
    );
    const [count] = await this.rows(
      `SELECT COUNT(*) AS total FROM \`${T.notifications}\` WHERE ${where}`,
      params,
    );
    return { items: items.map(notice), total: Number(count?.total ?? 0) };
  }

  public async unread(tenantId: string, recipientId: string, kinds: NotificationFilter['kinds']) {
    return (
      await this.list(tenantId, recipientId, { kinds, unreadOnly: true }, { limit: 1, offset: 0 })
    ).total;
  }

  public async markRead(
    tenantId: string,
    recipientId: string,
    ids: readonly string[] | null,
    kinds: NotificationFilter['kinds'],
    at: string,
  ) {
    if (kinds.length === 0 || (ids !== null && ids.length === 0)) return 0;
    const { where, params } = center(tenantId, recipientId, { kinds, unreadOnly: true });
    const byId = ids === null ? '' : ` AND id IN (${marks(ids.length)})`;
    return affected(
      await this.run(`UPDATE \`${T.notifications}\` SET read_at = ? WHERE ${where}${byId}`, [
        new Date(at),
        ...params,
        ...(ids ?? []),
      ]),
    );
  }

  public async find(tenantId: string, recipientId: string, id: string) {
    const [row] = await this.rows(
      `SELECT * FROM \`${T.notifications}\` WHERE company_id = ? AND recipient_id = ? AND id = ?`,
      [tenantId, recipientId, id],
    );
    return row ? notice(row) : null;
  }

  public async claimDue(
    tenantId: string,
    now: Date,
    leaseMs: number,
    limit: number,
  ): Promise<readonly DeliveryWork[]> {
    const due = await this.rows(
      `SELECT * FROM \`${T.deliveries}\` WHERE company_id = ? AND status = 'pending'
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?) AND (lease_until IS NULL OR lease_until <= ?)
         ORDER BY next_attempt_at, notification_id LIMIT ?`,
      [tenantId, now, now, limit],
    );
    const work: DeliveryWork[] = [];
    for (const row of due) {
      const lease = new Date(now.getTime() + leaseMs);
      // Compare and set: only the worker that moves the lease from a past instant owns the send.
      const taken = affected(
        await this.run(
          `UPDATE \`${T.deliveries}\` SET lease_until = ? WHERE company_id = ? AND notification_id = ? AND channel = ?
             AND status = 'pending' AND (lease_until IS NULL OR lease_until <= ?)`,
          [lease, tenantId, row.notification_id, row.channel, now],
        ),
      );
      if (taken !== 1) continue;
      const [owner] = await this.rows(
        `SELECT * FROM \`${T.notifications}\` WHERE company_id = ? AND id = ?`,
        [tenantId, row.notification_id],
      );
      if (owner)
        work.push({
          delivery: delivery({ ...row, lease_until: lease }),
          notification: notice(owner),
        });
    }
    return work;
  }

  public async renew(
    tenantId: string,
    notificationId: string,
    channel: Channel,
    lease: string | null,
    now: Date,
    leaseMs: number,
  ) {
    const renewed = new Date(now.getTime() + leaseMs);
    const taken = affected(
      await this.run(
        `UPDATE \`${T.deliveries}\` SET lease_until = ?
           WHERE company_id = ? AND notification_id = ? AND channel = ? AND status = 'pending'
             AND lease_until <=> ?`,
        [renewed, tenantId, notificationId, channel, date(lease)],
      ),
    );
    return taken === 1 ? renewed.toISOString() : null;
  }

  public async settle(
    tenantId: string,
    notificationId: string,
    channel: Channel,
    outcome: DeliveryOutcome,
    at: string,
    lease: string | null = null,
  ) {
    const change = outcomeChange(outcome);
    return (
      affected(
        await this.run(
          `UPDATE \`${T.deliveries}\` SET ${change.sql}, updated_at = ?, lease_until = NULL
             WHERE company_id = ? AND notification_id = ? AND channel = ? AND status = 'pending'
               AND lease_until <=> ?`,
          [...change.params, new Date(at), tenantId, notificationId, channel, date(lease)],
        ),
      ) === 1
    );
  }

  public async deliveries(tenantId: string, notificationId: string) {
    const rows = await this.rows(
      `SELECT * FROM \`${T.deliveries}\` WHERE company_id = ? AND notification_id = ? ORDER BY channel`,
      [tenantId, notificationId],
    );
    // In-app first, like the order the domain creates them in.
    return rows
      .map(delivery)
      .sort((a, b) => Number(b.channel === 'in_app') - Number(a.channel === 'in_app'));
  }

  public async failed(tenantId: string, window: NotificationWindow) {
    const rows = await this.rows(
      `SELECT d.notification_id, d.channel, d.attempts, d.last_error, d.updated_at, n.event_kind
         FROM \`${T.deliveries}\` d JOIN \`${T.notifications}\` n
           ON n.company_id = d.company_id AND n.id = d.notification_id
        WHERE d.company_id = ? AND d.status = 'failed'
        ORDER BY d.updated_at DESC, d.notification_id DESC LIMIT ? OFFSET ?`,
      [tenantId, window.limit, window.offset],
    );
    const [count] = await this.rows(
      `SELECT COUNT(*) AS total FROM \`${T.deliveries}\` WHERE company_id = ? AND status = 'failed'`,
      [tenantId],
    );
    const items: FailedDelivery[] = rows.map((row) => ({
      notificationId: row.notification_id as string,
      eventKind: row.event_kind as EventKind,
      channel: row.channel as Channel,
      attempts: Number(row.attempts),
      lastError: (row.last_error as string | null) ?? null,
      updatedAt: iso(row.updated_at) as string,
    }));
    return { items, total: Number(count?.total ?? 0) };
  }

  public async preferences(tenantId: string, recipientId: string): Promise<readonly Preference[]> {
    const rows = await this.rows(
      `SELECT event_kind, in_app, email FROM \`${T.preferences}\` WHERE company_id = ? AND recipient_id = ? ORDER BY event_kind`,
      [tenantId, recipientId],
    );
    return rows
      .filter((row) => isEventKind(row.event_kind))
      .map((row) => ({
        eventKind: row.event_kind as EventKind,
        inApp: flag(row.in_app),
        email: flag(row.email),
      }));
  }

  public async savePreferences(
    tenantId: string,
    recipientId: string,
    preferences: readonly Preference[],
    at: string,
  ) {
    await this.dataSource.transaction('READ COMMITTED', async (manager) => {
      for (const item of preferences)
        await this.run(
          `INSERT INTO \`${T.preferences}\` (company_id,recipient_id,event_kind,in_app,email,updated_at) VALUES (?,?,?,?,?,?)
             ON DUPLICATE KEY UPDATE in_app = VALUES(in_app), email = VALUES(email), updated_at = VALUES(updated_at)`,
          [
            tenantId,
            recipientId,
            item.eventKind,
            item.inApp ? 1 : 0,
            item.email ? 1 : 0,
            new Date(at),
          ],
          manager,
        );
    });
  }

  public async rule(tenantId: string): Promise<CompanyRule | null> {
    const [row] = await this.rows(`SELECT * FROM \`${T.rules}\` WHERE company_id = ?`, [tenantId]);
    if (!row) return null;
    const stored =
      typeof row.email_kinds === 'string' ? JSON.parse(row.email_kinds) : row.email_kinds;
    return {
      emailKinds: (stored as unknown[]).filter(isEventKind),
      quietHours: flag(row.quiet_hours),
      updatedAt: iso(row.updated_at),
    };
  }

  public async saveRule(tenantId: string, rule: CompanyRule) {
    await this.run(
      `INSERT INTO \`${T.rules}\` (company_id,email_kinds,quiet_hours,updated_at) VALUES (?,?,?,?)
         ON DUPLICATE KEY UPDATE email_kinds = VALUES(email_kinds), quiet_hours = VALUES(quiet_hours), updated_at = VALUES(updated_at)`,
      [tenantId, JSON.stringify(rule.emailKinds), rule.quietHours ? 1 : 0, date(rule.updatedAt)],
    );
  }

  public async subscribe(subscription: Subscription) {
    await this.run(
      `INSERT IGNORE INTO \`${T.subscriptions}\` (company_id,recipient_id,entity_type,entity_id,created_at) VALUES (?,?,?,?,?)`,
      [
        subscription.tenantId,
        subscription.recipientId,
        subscription.entityType,
        subscription.entityId,
        new Date(subscription.createdAt),
      ],
    );
  }

  public async unsubscribe(
    tenantId: string,
    recipientId: string,
    type: SubscriptionType,
    entityId: string,
  ) {
    return (
      affected(
        await this.run(
          `DELETE FROM \`${T.subscriptions}\` WHERE company_id = ? AND recipient_id = ? AND entity_type = ? AND entity_id = ?`,
          [tenantId, recipientId, type, entityId],
        ),
      ) === 1
    );
  }

  public async subscriptionsOf(tenantId: string, recipientId: string, type?: SubscriptionType) {
    const rows = await this.rows(
      `SELECT * FROM \`${T.subscriptions}\` WHERE company_id = ? AND recipient_id = ?${type ? ' AND entity_type = ?' : ''}
         ORDER BY created_at, entity_id`,
      type ? [tenantId, recipientId, type] : [tenantId, recipientId],
    );
    return rows
      .filter((row) => isSubscriptionType(row.entity_type))
      .map(
        (row): Subscription => ({
          tenantId: row.company_id as string,
          recipientId: row.recipient_id as string,
          entityType: row.entity_type as SubscriptionType,
          entityId: row.entity_id as string,
          createdAt: iso(row.created_at) as string,
        }),
      );
  }

  public async subscribersOf(tenantId: string, type: SubscriptionType, entityId: string) {
    const rows = await this.rows(
      `SELECT recipient_id FROM \`${T.subscriptions}\` WHERE company_id = ? AND entity_type = ? AND entity_id = ? ORDER BY recipient_id`,
      [tenantId, type, entityId],
    );
    return rows.map((row) => row.recipient_id as string);
  }
}
