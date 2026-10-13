import type { IncidentStore } from '../../cases/src/index.js';
import { alertEventOf, alertIdOf, parseSlaAlertPayload } from './events.js';
import type {
  AlertFilter,
  AlertWindow,
  ClaimResult,
  IncidentSlaStore,
  Settlement,
} from './ports.js';
import { visibleTo, type Viewer } from './recipients.js';
import { alertKey } from './scan.js';
import type { CycleRow, DeliveryKey, DeliveryRow, NewAlert, SlaAlert } from './types.js';

/** An outbox event as the in-memory store hands it on; the composition enqueues it in the real outbox. */
export interface SlaEvent {
  readonly tenantId: string;
  readonly type: string;
  readonly payload: Readonly<Record<string, string | number>>;
}
const tuple = (...parts: (string | number)[]) => JSON.stringify(parts);

interface DeliveryState extends DeliveryKey {
  status: DeliveryRow['status'];
  attempts: number;
  nextAttemptAt: string | null;
  leaseUntil: number | null;
}

/**
 * In-memory store for unit tests and the non-persistent composition; same keys and the same
 * claim/lease semantics as MySQL. `emit` is where the notice's event goes, and it must throw to
 * refuse: then no notice is kept, as in a rolled-back transaction.
 */
export class InMemoryIncidentSlaStore implements IncidentSlaStore {
  private readonly cycleRows = new Map<string, CycleRow>();
  private readonly alerts = new Map<string, SlaAlert>();
  private readonly keys = new Set<string>();
  private readonly rows = new Map<string, DeliveryState>();
  public constructor(
    private readonly incidents: IncidentStore,
    private readonly emit: (event: SlaEvent) => void = () => undefined,
  ) {}

  public async cycles(tenantId: string, ids: readonly string[]): Promise<readonly CycleRow[]> {
    return [...this.cycleRows.values()]
      .filter((row) => row.tenantId === tenantId && ids.includes(row.incidentId))
      .map((row) => structuredClone(row));
  }
  public async openCycle(row: CycleRow): Promise<void> {
    const key = tuple(row.tenantId, row.incidentId, row.cycle);
    if (!this.cycleRows.has(key)) this.cycleRows.set(key, structuredClone(row));
  }
  public async retarget(row: CycleRow, expectedTargetVersion: number): Promise<boolean> {
    const key = tuple(row.tenantId, row.incidentId, row.cycle);
    if (this.cycleRows.get(key)?.targetVersion !== expectedTargetVersion) return false;
    this.cycleRows.set(key, structuredClone(row));
    return true;
  }

  public async alertKeys(tenantId: string, ids: readonly string[]): Promise<ReadonlySet<string>> {
    return new Set(
      [...this.alerts.values()]
        .filter((alert) => alert.tenantId === tenantId && ids.includes(alert.incidentId))
        .map((a) => alertKey(a.incidentId, a.cycle, a.kind, a.dedupeRef)),
    );
  }
  public async createAlert(alert: NewAlert): Promise<SlaAlert | null> {
    const id = alertIdOf(alert);
    const key = tuple(alert.tenantId, id);
    if (this.alerts.has(key)) return null;
    const saved: SlaAlert = { ...structuredClone(alert), id };
    const event = alertEventOf(saved);
    parseSlaAlertPayload(event.payload);
    this.emit({ tenantId: alert.tenantId, ...event });
    this.alerts.set(key, saved);
    return structuredClone(saved);
  }
  /** Every notice of a tenant, oldest first; for tests and diagnostics. */
  public all(tenantId: string): readonly SlaAlert[] {
    return [...this.alerts.values()].filter((alert) => alert.tenantId === tenantId);
  }
  public async alert(tenantId: string, alertId: string): Promise<SlaAlert | null> {
    const found = this.alerts.get(tuple(tenantId, alertId));
    return found ? structuredClone(found) : null;
  }
  public async listAlerts(
    tenantId: string,
    viewer: Viewer,
    filter: AlertFilter,
    window: AlertWindow,
  ): Promise<{ rows: readonly SlaAlert[]; total: number }> {
    const matching: SlaAlert[] = [];
    for (const alert of this.alerts.values()) {
      if (
        alert.tenantId !== tenantId ||
        (filter.kind && alert.kind !== filter.kind) ||
        (filter.incidentId && alert.incidentId !== filter.incidentId)
      )
        continue;
      const incident = await this.incidents.get(tenantId, alert.incidentId);
      if (visibleTo(alert, incident?.responsibleId ?? null, viewer)) matching.push(alert);
    }
    matching.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    return {
      rows: matching
        .slice(window.offset, window.offset + window.limit)
        .map((a) => structuredClone(a)),
      total: matching.length,
    };
  }

  private deliveryKey = (key: DeliveryKey) =>
    tuple(key.tenantId, key.alertId, key.recipientId, key.channel);
  public async claimDelivery(key: DeliveryKey, now: string, leaseMs: number): Promise<ClaimResult> {
    const id = this.deliveryKey(key);
    const row: DeliveryState = this.rows.get(id) ?? {
      ...key,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: null,
      leaseUntil: null,
    };
    this.rows.set(id, row);
    if (row.status !== 'pending') return { result: 'done' };
    const at = Date.parse(now);
    if (row.leaseUntil !== null && row.leaseUntil > at) return { result: 'busy' };
    row.attempts += 1;
    row.leaseUntil = at + leaseMs;
    return { result: 'claimed', attempt: row.attempts };
  }
  public async settleDelivery(key: DeliveryKey, attempt: number, s: Settlement): Promise<void> {
    const row = this.rows.get(this.deliveryKey(key));
    if (row?.status !== 'pending' || row.attempts !== attempt) return;
    row.leaseUntil = null;
    if (s.status === 'retry') row.nextAttemptAt = s.nextAttemptAt;
    else row.status = s.status;
  }
  public async skipDelivery(key: DeliveryKey): Promise<void> {
    const id = this.deliveryKey(key);
    const row = this.rows.get(id);
    if (row?.status === 'sent' || row?.status === 'failed') return;
    this.rows.set(id, {
      ...key,
      status: 'skipped',
      attempts: row?.attempts ?? 0,
      nextAttemptAt: null,
      leaseUntil: null,
    });
  }
  public async deliveries(tenantId: string, alertId: string): Promise<readonly DeliveryRow[]> {
    return [...this.rows.values()]
      .filter((row) => row.tenantId === tenantId && row.alertId === alertId)
      .map(({ leaseUntil: _lease, ...row }) => structuredClone(row));
  }
}
