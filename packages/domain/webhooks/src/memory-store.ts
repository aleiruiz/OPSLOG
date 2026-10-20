import type { WebhookStore } from './ports.js';
import type {
  AttemptOutcome,
  Delivery,
  DeliveryWork,
  DriverState,
  Endpoint,
  NewDelivery,
  Slice,
  Window,
} from './types.js';
import { DISABLE_AFTER_FAILURES } from './catalog.js';

const key = (...parts: string[]): string => parts.join('\u0000');

/** Reference store for the tests and for a platform without a database. Single process. */
export class InMemoryWebhookStore implements WebhookStore {
  private readonly endpointRows = new Map<string, Endpoint>();
  private readonly deliveryRows = new Map<string, Delivery>();
  private readonly driverRows = new Map<string, DriverState>();

  public async createEndpoint(endpoint: Endpoint, max: number): Promise<boolean> {
    const count = [...this.endpointRows.values()].filter(
      (e) => e.tenantId === endpoint.tenantId,
    ).length;
    if (count >= max) return false;
    this.endpointRows.set(key(endpoint.tenantId, endpoint.id), endpoint);
    return true;
  }

  public async endpoints(tenantId: string): Promise<readonly Endpoint[]> {
    return [...this.endpointRows.values()]
      .filter((e) => e.tenantId === tenantId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  public async endpoint(tenantId: string, id: string): Promise<Endpoint | null> {
    return this.endpointRows.get(key(tenantId, id)) ?? null;
  }

  public async saveEndpoint(next: Endpoint, expectedVersion: number): Promise<boolean> {
    const found = this.endpointRows.get(key(next.tenantId, next.id));
    if (!found || found.version !== expectedVersion) return false;
    this.endpointRows.set(key(next.tenantId, next.id), next);
    return true;
  }

  public async deleteEndpoint(tenantId: string, id: string): Promise<boolean> {
    if (!this.endpointRows.delete(key(tenantId, id))) return false;
    for (const [k, d] of this.deliveryRows)
      if (d.tenantId === tenantId && d.endpointId === id) this.deliveryRows.delete(k);
    return true;
  }

  public async addDeliveries(deliveries: readonly NewDelivery[]): Promise<number> {
    let created = 0;
    for (const item of deliveries) {
      const duplicate = [...this.deliveryRows.values()].some(
        (d) =>
          d.tenantId === item.tenantId &&
          d.endpointId === item.endpointId &&
          d.eventId === item.eventId,
      );
      if (duplicate) continue;
      this.deliveryRows.set(key(item.tenantId, item.id), {
        ...item,
        status: 'pending',
        attempts: 0,
        manual: false,
        nextAttemptAt: item.createdAt,
        leaseUntil: null,
        lastAttemptAt: null,
        lastStatusCode: null,
        lastDurationMs: null,
        lastError: null,
        updatedAt: item.createdAt,
      });
      created += 1;
    }
    return created;
  }

  public async deliveries(
    tenantId: string,
    endpointId: string,
    window: Window,
  ): Promise<Slice<Delivery>> {
    const all = [...this.deliveryRows.values()]
      .filter((d) => d.tenantId === tenantId && d.endpointId === endpointId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    return { items: all.slice(window.offset, window.offset + window.limit), total: all.length };
  }

  public async delivery(
    tenantId: string,
    endpointId: string,
    id: string,
  ): Promise<Delivery | null> {
    const found = this.deliveryRows.get(key(tenantId, id));
    return found && found.endpointId === endpointId ? found : null;
  }

  public async retryNow(
    tenantId: string,
    endpointId: string,
    id: string,
    at: string,
  ): Promise<Delivery | null> {
    const found = await this.delivery(tenantId, endpointId, id);
    if (!found || (found.status !== 'dead_letter' && found.status !== 'failed')) return null;
    const next: Delivery = {
      ...found,
      status: 'pending',
      manual: true,
      nextAttemptAt: at,
      leaseUntil: null,
      updatedAt: at,
    };
    this.deliveryRows.set(key(tenantId, id), next);
    return next;
  }

  public async claimDue(
    tenantId: string,
    now: Date,
    leaseMs: number,
    limit: number,
  ): Promise<readonly DeliveryWork[]> {
    const due = [...this.deliveryRows.values()]
      .filter(
        (d) =>
          d.tenantId === tenantId &&
          (d.status === 'pending' || d.status === 'failed') &&
          d.nextAttemptAt !== null &&
          Date.parse(d.nextAttemptAt) <= now.getTime() &&
          (d.leaseUntil === null || Date.parse(d.leaseUntil) <= now.getTime()) &&
          this.endpointRows.get(key(tenantId, d.endpointId))?.active === true,
      )
      .sort(
        (a, b) =>
          (a.nextAttemptAt as string).localeCompare(b.nextAttemptAt as string) ||
          a.id.localeCompare(b.id),
      )
      .slice(0, limit);
    return due.map((d) => {
      const taken: Delivery = {
        ...d,
        leaseUntil: new Date(now.getTime() + leaseMs).toISOString(),
        lastAttemptAt: now.toISOString(),
      };
      this.deliveryRows.set(key(tenantId, d.id), taken);
      return {
        delivery: taken,
        endpoint: this.endpointRows.get(key(tenantId, d.endpointId)) as Endpoint,
      };
    });
  }

  private open(tenantId: string, id: string, lease: string | null): Delivery | null {
    const found = this.deliveryRows.get(key(tenantId, id));
    if (!found || (found.status !== 'pending' && found.status !== 'failed')) return null;
    return found.leaseUntil === lease ? found : null;
  }

  public async renew(
    tenantId: string,
    deliveryId: string,
    lease: string | null,
    now: Date,
    leaseMs: number,
  ): Promise<string | null> {
    const found = this.open(tenantId, deliveryId, lease);
    if (!found) return null;
    const renewed = new Date(now.getTime() + leaseMs).toISOString();
    this.deliveryRows.set(key(tenantId, deliveryId), { ...found, leaseUntil: renewed });
    return renewed;
  }

  public async settle(
    tenantId: string,
    deliveryId: string,
    outcome: AttemptOutcome,
    at: string,
    lease: string | null,
  ): Promise<boolean> {
    const found = this.open(tenantId, deliveryId, lease);
    if (!found) return false;
    const base = {
      ...found,
      attempts: found.attempts + 1,
      manual: false,
      leaseUntil: null,
      lastAttemptAt: at,
      lastStatusCode: outcome.statusCode,
      lastDurationMs: outcome.durationMs,
      updatedAt: at,
    };
    const next: Delivery =
      outcome.kind === 'delivered'
        ? { ...base, status: 'delivered', nextAttemptAt: null, lastError: null }
        : outcome.kind === 'retry'
          ? {
              ...base,
              status: 'failed',
              nextAttemptAt: outcome.nextAttemptAt,
              lastError: outcome.error,
            }
          : { ...base, status: 'dead_letter', nextAttemptAt: null, lastError: outcome.error };
    this.deliveryRows.set(key(tenantId, deliveryId), next);
    return true;
  }

  public async attemptsSince(tenantId: string, since: Date): Promise<number> {
    return [...this.deliveryRows.values()].filter(
      (d) =>
        d.tenantId === tenantId &&
        d.lastAttemptAt !== null &&
        Date.parse(d.lastAttemptAt) > since.getTime(),
    ).length;
  }

  public async noteResult(
    tenantId: string,
    endpointId: string,
    ok: boolean,
    at: string,
  ): Promise<{ disabled: boolean }> {
    const found = this.endpointRows.get(key(tenantId, endpointId));
    if (!found) return { disabled: false };
    const failures = ok ? 0 : found.consecutiveFailures + 1;
    const disable = !ok && failures >= DISABLE_AFTER_FAILURES && found.active;
    this.endpointRows.set(key(tenantId, endpointId), {
      ...found,
      consecutiveFailures: failures,
      active: disable ? false : found.active,
      disabledReason: disable ? 'failures' : found.disabledReason,
      updatedAt: disable ? at : found.updatedAt,
    });
    return { disabled: disable };
  }

  public async purge(tenantId: string, before: Date): Promise<number> {
    let removed = 0;
    for (const [k, d] of this.deliveryRows)
      if (d.tenantId === tenantId && Date.parse(d.createdAt) < before.getTime()) {
        this.deliveryRows.delete(k);
        removed += 1;
      }
    return removed;
  }

  public async driverState(tenantId: string, driverId: string): Promise<DriverState | null> {
    return this.driverRows.get(key(tenantId, driverId)) ?? null;
  }

  public async saveDriverState(state: DriverState): Promise<void> {
    this.driverRows.set(key(state.tenantId, state.driverId), state);
  }
}
