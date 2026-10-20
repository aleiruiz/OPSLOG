import 'reflect-metadata';
import { createHash } from 'node:crypto';
import type { DataSource, EntityManager } from 'typeorm';
import {
  DISABLE_AFTER_FAILURES,
  type AttemptOutcome,
  type Delivery,
  type DeliveryWork,
  type DriverState,
  type Endpoint,
  type NewDelivery,
  type Slice,
  type WebhookStore,
  type Window,
} from '../../../domain/webhooks/src/index.js';
import { WEBHOOK_RUNTIME_ACCOUNT } from './data-source.js';
import { WEBHOOK_TABLES as T } from './entities.js';
import {
  DUPLICATE_KEY,
  affected,
  date,
  delivery,
  endpoint,
  errno,
  flag,
  outcomeChange,
  type Row,
} from './rows.js';

const OPEN = "status IN ('pending','failed')";

/** TypeORM adapter of the webhooks. Every statement names the company; none crosses it. */
export class TypeOrmWebhookStore implements WebhookStore {
  public constructor(private readonly dataSource: DataSource) {
    const username = (dataSource.options as { username?: string }).username ?? '';
    if (!WEBHOOK_RUNTIME_ACCOUNT.test(username))
      throw new Error('Webhook store requires its restricted runtime account');
  }

  private run(sql: string, params: readonly unknown[], manager?: EntityManager): Promise<unknown> {
    return (manager ?? this.dataSource).query(sql, [...params]);
  }
  private async rows(sql: string, params: readonly unknown[], manager?: EntityManager) {
    return (await this.run(sql, params, manager)) as Row[];
  }

  public async createEndpoint(next: Endpoint, max: number): Promise<boolean> {
    // The count and the insert are one critical section per company: two concurrent creations
    // cannot both pass the limit.
    const lock = `whep:${createHash('sha256').update(next.tenantId).digest('hex').slice(0, 40)}`;
    // The lock lives on its own connection and is released after the commit, so the next
    // creation counts the row this one inserted.
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    try {
      const [got] = (await runner.query('SELECT GET_LOCK(?, 10) AS got', [lock])) as Row[];
      if (Number(got?.got) !== 1) throw new Error('webhook endpoint limit lock unavailable');
      try {
        const [count] = (await runner.query(
          `SELECT COUNT(*) AS total FROM \`${T.endpoints}\` WHERE company_id = ?`,
          [next.tenantId],
        )) as Row[];
        if (Number(count?.total ?? 0) >= max) return false;
        await runner.query(
          `INSERT INTO \`${T.endpoints}\` (company_id,id,url,events,active,disabled_reason,company_ref,secret_sealed,previous_sealed,previous_expires_at,consecutive_failures,version,created_at,updated_at,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            next.tenantId,
            next.id,
            next.url,
            JSON.stringify(next.events),
            next.active ? 1 : 0,
            next.disabledReason,
            next.companyRef,
            next.secretSealed,
            next.previousSealed,
            date(next.previousExpiresAt),
            next.consecutiveFailures,
            next.version,
            new Date(next.createdAt),
            new Date(next.updatedAt),
            next.createdBy,
          ],
        );
        return true;
      } finally {
        await runner.query('SELECT RELEASE_LOCK(?)', [lock]);
      }
    } finally {
      await runner.release();
    }
  }

  public async endpoints(tenantId: string): Promise<readonly Endpoint[]> {
    return (
      await this.rows(
        `SELECT * FROM \`${T.endpoints}\` WHERE company_id = ? ORDER BY created_at, id`,
        [tenantId],
      )
    ).map(endpoint);
  }

  public async endpoint(tenantId: string, id: string): Promise<Endpoint | null> {
    const [row] = await this.rows(
      `SELECT * FROM \`${T.endpoints}\` WHERE company_id = ? AND id = ?`,
      [tenantId, id],
    );
    return row ? endpoint(row) : null;
  }

  public async saveEndpoint(next: Endpoint, expectedVersion: number): Promise<boolean> {
    return (
      affected(
        await this.run(
          `UPDATE \`${T.endpoints}\` SET url = ?, events = ?, active = ?, disabled_reason = ?, secret_sealed = ?,
             previous_sealed = ?, previous_expires_at = ?, consecutive_failures = ?, version = ?, updated_at = ?
             WHERE company_id = ? AND id = ? AND version = ?`,
          [
            next.url,
            JSON.stringify(next.events),
            next.active ? 1 : 0,
            next.disabledReason,
            next.secretSealed,
            next.previousSealed,
            date(next.previousExpiresAt),
            next.consecutiveFailures,
            next.version,
            new Date(next.updatedAt),
            next.tenantId,
            next.id,
            expectedVersion,
          ],
        ),
      ) === 1
    );
  }

  public async deleteEndpoint(tenantId: string, id: string): Promise<boolean> {
    return this.dataSource.transaction('READ COMMITTED', async (manager) => {
      await this.run(
        `DELETE FROM \`${T.deliveries}\` WHERE company_id = ? AND endpoint_id = ?`,
        [tenantId, id],
        manager,
      );
      return (
        affected(
          await this.run(
            `DELETE FROM \`${T.endpoints}\` WHERE company_id = ? AND id = ?`,
            [tenantId, id],
            manager,
          ),
        ) === 1
      );
    });
  }

  public async addDeliveries(deliveries: readonly NewDelivery[]): Promise<number> {
    let created = 0;
    for (const item of deliveries) {
      try {
        await this.run(
          `INSERT INTO \`${T.deliveries}\` (company_id,id,endpoint_id,event_id,event_type,body,status,attempts,manual,next_attempt_at,lease_until,last_attempt_at,last_status_code,last_duration_ms,last_error,created_at,updated_at)
             VALUES (?,?,?,?,?,?,'pending',0,0,?,NULL,NULL,NULL,NULL,NULL,?,?)`,
          [
            item.tenantId,
            item.id,
            item.endpointId,
            item.eventId,
            item.eventType,
            item.body,
            new Date(item.createdAt),
            new Date(item.createdAt),
            new Date(item.createdAt),
          ],
        );
        created += 1;
      } catch (error) {
        // The same event for the same endpoint: already there.
        if (errno(error) !== DUPLICATE_KEY) throw error;
      }
    }
    return created;
  }

  public async deliveries(
    tenantId: string,
    endpointId: string,
    window: Window,
  ): Promise<Slice<Delivery>> {
    const items = await this.rows(
      `SELECT * FROM \`${T.deliveries}\` WHERE company_id = ? AND endpoint_id = ?
         ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      [tenantId, endpointId, window.limit, window.offset],
    );
    const [count] = await this.rows(
      `SELECT COUNT(*) AS total FROM \`${T.deliveries}\` WHERE company_id = ? AND endpoint_id = ?`,
      [tenantId, endpointId],
    );
    return { items: items.map(delivery), total: Number(count?.total ?? 0) };
  }

  public async delivery(tenantId: string, endpointId: string, id: string) {
    const [row] = await this.rows(
      `SELECT * FROM \`${T.deliveries}\` WHERE company_id = ? AND endpoint_id = ? AND id = ?`,
      [tenantId, endpointId, id],
    );
    return row ? delivery(row) : null;
  }

  public async retryNow(tenantId: string, endpointId: string, id: string, at: string) {
    const changed = affected(
      await this.run(
        `UPDATE \`${T.deliveries}\` SET status = 'pending', manual = 1, next_attempt_at = ?, lease_until = NULL, updated_at = ?
           WHERE company_id = ? AND endpoint_id = ? AND id = ? AND status IN ('dead_letter','failed')`,
        [new Date(at), new Date(at), tenantId, endpointId, id],
      ),
    );
    return changed === 1 ? this.delivery(tenantId, endpointId, id) : null;
  }

  public async claimDue(
    tenantId: string,
    now: Date,
    leaseMs: number,
    limit: number,
  ): Promise<readonly DeliveryWork[]> {
    const due = await this.rows(
      `SELECT d.id FROM \`${T.deliveries}\` d JOIN \`${T.endpoints}\` e ON e.company_id = d.company_id AND e.id = d.endpoint_id
         WHERE d.company_id = ? AND d.${OPEN} AND e.active = 1 AND d.next_attempt_at <= ?
           AND (d.lease_until IS NULL OR d.lease_until <= ?)
         ORDER BY d.next_attempt_at, d.id LIMIT ?`,
      [tenantId, now, now, limit],
    );
    const endpoints = new Map<string, Endpoint>();
    const work: DeliveryWork[] = [];
    for (const { id } of due) {
      const lease = new Date(now.getTime() + leaseMs);
      // Compare and set: only the worker that moves the lease from a past instant owns the send.
      // The claim also stamps the attempt, so the per-minute window sees it at once.
      const taken = affected(
        await this.run(
          `UPDATE \`${T.deliveries}\` SET lease_until = ?, last_attempt_at = ?
             WHERE company_id = ? AND id = ? AND ${OPEN} AND next_attempt_at <= ?
               AND (lease_until IS NULL OR lease_until <= ?)`,
          [lease, now, tenantId, id, now, now],
        ),
      );
      if (taken !== 1) continue;
      const [row] = await this.rows(
        `SELECT * FROM \`${T.deliveries}\` WHERE company_id = ? AND id = ?`,
        [tenantId, id],
      );
      if (!row) continue;
      const claimed = delivery(row);
      let owner = endpoints.get(claimed.endpointId);
      if (!owner) {
        owner = (await this.endpoint(tenantId, claimed.endpointId)) ?? undefined;
        if (owner) endpoints.set(owner.id, owner);
      }
      if (owner) work.push({ delivery: claimed, endpoint: owner });
    }
    return work;
  }

  public async renew(
    tenantId: string,
    deliveryId: string,
    lease: string | null,
    now: Date,
    leaseMs: number,
  ) {
    const renewed = new Date(now.getTime() + leaseMs);
    const taken = affected(
      await this.run(
        `UPDATE \`${T.deliveries}\` SET lease_until = ?
           WHERE company_id = ? AND id = ? AND ${OPEN} AND lease_until <=> ?`,
        [renewed, tenantId, deliveryId, date(lease)],
      ),
    );
    return taken === 1 ? renewed.toISOString() : null;
  }

  public async settle(
    tenantId: string,
    deliveryId: string,
    outcome: AttemptOutcome,
    at: string,
    lease: string | null,
  ) {
    const change = outcomeChange(outcome);
    return (
      affected(
        await this.run(
          `UPDATE \`${T.deliveries}\` SET ${change.sql}, last_attempt_at = ?, updated_at = ?, lease_until = NULL
             WHERE company_id = ? AND id = ? AND ${OPEN} AND lease_until <=> ?`,
          [...change.params, new Date(at), new Date(at), tenantId, deliveryId, date(lease)],
        ),
      ) === 1
    );
  }

  public async attemptsSince(tenantId: string, since: Date) {
    const [row] = await this.rows(
      `SELECT COUNT(*) AS total FROM \`${T.deliveries}\` WHERE company_id = ? AND last_attempt_at > ?`,
      [tenantId, since],
    );
    return Number(row?.total ?? 0);
  }

  public async noteResult(tenantId: string, endpointId: string, ok: boolean, at: string) {
    if (ok) {
      await this.run(
        `UPDATE \`${T.endpoints}\` SET consecutive_failures = 0 WHERE company_id = ? AND id = ? AND consecutive_failures > 0`,
        [tenantId, endpointId],
      );
      return { disabled: false };
    }
    await this.run(
      `UPDATE \`${T.endpoints}\` SET consecutive_failures = consecutive_failures + 1 WHERE company_id = ? AND id = ?`,
      [tenantId, endpointId],
    );
    // Only the call that finds it still active switches it off, so the notice goes out once.
    const switched = affected(
      await this.run(
        `UPDATE \`${T.endpoints}\` SET active = 0, disabled_reason = 'failures', updated_at = ?
           WHERE company_id = ? AND id = ? AND active = 1 AND consecutive_failures >= ?`,
        [new Date(at), tenantId, endpointId, DISABLE_AFTER_FAILURES],
      ),
    );
    return { disabled: switched === 1 };
  }

  public async purge(tenantId: string, before: Date) {
    return affected(
      await this.run(`DELETE FROM \`${T.deliveries}\` WHERE company_id = ? AND created_at < ?`, [
        tenantId,
        before,
      ]),
    );
  }

  public async driverState(tenantId: string, driverId: string): Promise<DriverState | null> {
    const [row] = await this.rows(
      `SELECT * FROM \`${T.driverState}\` WHERE company_id = ? AND driver_id = ?`,
      [tenantId, driverId],
    );
    return row
      ? {
          tenantId,
          driverId,
          eligible: flag(row.eligible),
          transitions: Number(row.transitions),
          updatedAt: new Date(row.updated_at as Date).toISOString(),
        }
      : null;
  }

  public async saveDriverState(state: DriverState): Promise<void> {
    await this.run(
      `INSERT INTO \`${T.driverState}\` (company_id,driver_id,eligible,transitions,updated_at) VALUES (?,?,?,?,?)
         ON DUPLICATE KEY UPDATE eligible = VALUES(eligible), transitions = VALUES(transitions), updated_at = VALUES(updated_at)`,
      [
        state.tenantId,
        state.driverId,
        state.eligible ? 1 : 0,
        state.transitions,
        new Date(state.updatedAt),
      ],
    );
  }
}
