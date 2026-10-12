import { MaintenancePlanError } from './errors.js';
import type {
  MaintenancePlan,
  PlanAlertPage,
  PlanAlertQuery,
  PlanAlertReader,
  PlanAlertRecord,
  PlanStore,
} from './types.js';

const key = (tenantId: string, id: string) => `${tenantId.length}:${tenantId}${id}`;

export class InMemoryMaintenancePlanStore implements PlanStore, PlanAlertReader {
  private readonly plans = new Map<string, MaintenancePlan>();
  private readonly alerts: PlanAlertRecord[] = [];
  /** Test and demo seam: the worker persists these in production. */
  public seedAlert(alert: PlanAlertRecord): void {
    this.alerts.push(structuredClone(alert));
  }
  public async listAlerts(tenantId: string, query: PlanAlertQuery): Promise<PlanAlertPage> {
    const matching = this.alerts
      .filter(
        (alert) =>
          alert.tenantId === tenantId &&
          (query.planId === undefined || alert.planId === query.planId) &&
          (query.vehicleId === undefined || alert.vehicleId === query.vehicleId),
      )
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.id.localeCompare(a.id));
    return {
      items: matching
        .slice(query.offset, query.offset + query.limit)
        .map((a) => structuredClone(a)),
      total: matching.length,
    };
  }
  public async create(plan: MaintenancePlan, _actorId: string): Promise<MaintenancePlan> {
    const k = key(plan.tenantId, plan.id);
    if (this.plans.has(k)) throw new MaintenancePlanError('duplicate');
    this.plans.set(k, structuredClone(plan));
    return structuredClone(plan);
  }
  public async get(tenantId: string, id: string): Promise<MaintenancePlan | null> {
    const found = this.plans.get(key(tenantId, id));
    return found ? structuredClone(found) : null;
  }
  public async list(tenantId: string): Promise<readonly MaintenancePlan[]> {
    return [...this.plans.values()]
      .filter((plan) => plan.tenantId === tenantId)
      .map((plan) => structuredClone(plan));
  }
  public async update(
    plan: MaintenancePlan,
    expectedVersion: number,
    _actorId: string,
  ): Promise<boolean> {
    const k = key(plan.tenantId, plan.id);
    const current = this.plans.get(k);
    if (!current || current.version !== expectedVersion) return false;
    this.plans.set(k, structuredClone(plan));
    return true;
  }
  public async nextSequence(tenantId: string, planId: string): Promise<number> {
    if (!this.plans.has(key(tenantId, planId))) throw new MaintenancePlanError('not_found');
    return 1;
  }
}
