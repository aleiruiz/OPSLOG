import { validateWorkOrderEvent } from './events.js';
import type {
  WorkOrder,
  WorkOrderEvent,
  WorkOrderMutation,
  WorkOrderStore,
  WorkOrderTransition,
} from './types.js';

const key = (tenantId: string, id: string) => `${tenantId.length}:${tenantId}${id}`;
const OPEN_WORKSHOP: readonly WorkOrder['status'][] = ['in_progress', 'completed'];

/** In-memory store for unit tests and the non-persistent composition; same CAS semantics as MySQL. */
export class InMemoryWorkOrderStore implements WorkOrderStore {
  private readonly orders = new Map<string, WorkOrder>();
  private readonly transitions = new Map<string, WorkOrderTransition[]>();
  public readonly events: { readonly tenantId: string; readonly event: WorkOrderEvent }[] = [];
  public readonly audit: { readonly tenantId: string; readonly action: string }[] = [];

  public async apply(mutation: WorkOrderMutation): Promise<boolean> {
    const events = mutation.events.map(validateWorkOrderEvent);
    const k = key(mutation.order.tenantId, mutation.order.id);
    const current = this.orders.get(k);
    if (mutation.expectedVersion === null ? current : current?.version !== mutation.expectedVersion)
      return false;
    this.orders.set(k, structuredClone(mutation.order));
    if (mutation.transition) {
      const history = this.transitions.get(k) ?? [];
      history.push(structuredClone(mutation.transition));
      this.transitions.set(k, history);
    }
    this.audit.push({ tenantId: mutation.order.tenantId, action: mutation.auditAction });
    for (const event of events) this.events.push({ tenantId: mutation.order.tenantId, event });
    return true;
  }
  public async get(tenantId: string, id: string): Promise<WorkOrder | null> {
    const order = this.orders.get(key(tenantId, id));
    return order ? structuredClone(order) : null;
  }
  public async list(
    tenantId: string,
    filter: { readonly mechanicIds?: readonly string[] } = {},
  ): Promise<readonly WorkOrder[]> {
    return [...this.orders.values()]
      .filter((order) => order.tenantId === tenantId)
      .filter(
        (order) =>
          !filter.mechanicIds ||
          (order.mechanicId !== null && filter.mechanicIds.includes(order.mechanicId)),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
      .map((order) => structuredClone(order));
  }
  public async history(tenantId: string, id: string): Promise<readonly WorkOrderTransition[]> {
    return structuredClone(this.transitions.get(key(tenantId, id)) ?? []);
  }
  public async openWorkshopOrders(
    tenantId: string,
    vehicleId: string,
  ): Promise<readonly WorkOrder[]> {
    return (await this.list(tenantId)).filter(
      (order) =>
        order.vehicleId === vehicleId &&
        order.requiresWorkshop &&
        OPEN_WORKSHOP.includes(order.status),
    );
  }
}
