import { validateWorkOrderEvent } from './events.js';
import type { IdempotencyRecord, IdempotentCommand } from './idempotency.js';
import type {
  ClosedOrderFact,
  WorkOrderAnalyticsReads,
  WorkOrderAttachment,
  WorkOrder,
  WorkOrderEvent,
  WorkOrderMutation,
  WorkOrderStore,
  WorkOrderTransition,
} from './types.js';

const key = (tenantId: string, id: string) => `${tenantId.length}:${tenantId}${id}`;
const OPEN_WORKSHOP: readonly WorkOrder['status'][] = ['in_progress', 'completed'];

/** In-memory store for unit tests and the non-persistent composition; same CAS semantics as MySQL. */
export class InMemoryWorkOrderStore implements WorkOrderStore, WorkOrderAnalyticsReads {
  private readonly orders = new Map<string, WorkOrder>();
  private readonly transitions = new Map<string, WorkOrderTransition[]>();
  private readonly files = new Map<string, WorkOrderAttachment[]>();
  private readonly keys = new Map<string, IdempotencyRecord>();
  public readonly events: { readonly tenantId: string; readonly event: WorkOrderEvent }[] = [];
  public readonly audit: { readonly tenantId: string; readonly action: string }[] = [];

  public async apply(mutation: WorkOrderMutation): Promise<boolean> {
    const events = mutation.events.map(validateWorkOrderEvent);
    const k = key(mutation.order.tenantId, mutation.order.id);
    const current = this.orders.get(k);
    if (mutation.expectedVersion === null ? current : current?.version !== mutation.expectedVersion)
      return false;
    const claim = mutation.idempotency;
    const claimKey = claim
      ? JSON.stringify([mutation.order.tenantId, claim.actorId, claim.command, claim.key])
      : null;
    // A live key is taken (a concurrent duplicate or a retry): nothing is written.
    if (claim && claimKey) {
      const taken = this.keys.get(claimKey);
      if (taken && taken.expiresAt > claim.createdAt) return false;
    }
    const change = mutation.file;
    const linked = this.files.get(k) ?? [];
    if (change?.op === 'attach') {
      // One link per file in the tenant, whatever the order.
      const taken = [...this.files.entries()].some(
        ([owner, list]) =>
          owner.startsWith(`${mutation.order.tenantId.length}:${mutation.order.tenantId}`) &&
          list.some((link) => link.fileId === change.attachment.fileId),
      );
      if (taken) return false;
      this.files.set(k, [...linked, structuredClone(change.attachment)]);
    } else if (change?.op === 'detach') {
      this.files.set(
        k,
        linked.filter((link) => link.id !== change.attachmentId),
      );
    }
    this.orders.set(k, structuredClone(mutation.order));
    if (mutation.transition) {
      const history = this.transitions.get(k) ?? [];
      history.push(structuredClone(mutation.transition));
      this.transitions.set(k, history);
    }
    if (claim && claimKey)
      this.keys.set(claimKey, {
        ...claim,
        tenantId: mutation.order.tenantId,
        status: 'completed',
        response: structuredClone(mutation.order),
      });
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
  public async closedFacts(
    tenantId: string,
    window: { readonly from: string; readonly to: string },
  ): Promise<readonly ClosedOrderFact[]> {
    return [...this.orders.values()]
      .filter(
        (order) =>
          order.tenantId === tenantId &&
          order.status === 'closed' &&
          order.closedAt !== null &&
          order.closedAt >= window.from &&
          order.closedAt < window.to,
      )
      .map((order) => ({
        vehicleId: order.vehicleId,
        kind: order.kind,
        scheduledDate: order.scheduledDate,
        actualDate: order.actualDate,
        costs: order.costs.map((cost) => ({ ...cost.amount })),
      }));
  }
  public async history(tenantId: string, id: string): Promise<readonly WorkOrderTransition[]> {
    return structuredClone(this.transitions.get(key(tenantId, id)) ?? []);
  }
  public async idempotency(
    tenantId: string,
    actorId: string,
    command: IdempotentCommand,
    key: string,
  ): Promise<IdempotencyRecord | null> {
    const record = this.keys.get(JSON.stringify([tenantId, actorId, command, key]));
    return record ? structuredClone(record) : null;
  }
  public async attachments(
    tenantId: string,
    orderId: string,
  ): Promise<readonly WorkOrderAttachment[]> {
    return structuredClone(this.files.get(key(tenantId, orderId)) ?? []);
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
