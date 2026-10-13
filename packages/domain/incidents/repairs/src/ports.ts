import type { IncidentApplyResult, IncidentMutation } from '../../cases/src/index.js';

/** A work order amount, exact in the minor unit of its currency. */
export interface OrderMoney {
  readonly amountMinor: string;
  readonly currency: string;
}

/** What this module reads of a work order of the workshop. It never writes one (INC-COSTS invariant 8). */
export interface RepairOrderRef {
  readonly id: string;
  readonly vehicleId: string;
  readonly kind: 'preventive' | 'corrective';
  readonly status: 'scheduled' | 'assigned' | 'in_progress' | 'completed' | 'closed' | 'cancelled';
  readonly version: number;
  readonly description: string | null;
  /** The name the screens show; never the id of the workshop. */
  readonly workshopName: string | null;
  /** The cost lines of the order. They never leave this module without `incidents:view_costs`. */
  readonly costs: readonly OrderMoney[];
}

/** Reads one order of the tenant; `null` when it is unknown or belongs to another tenant. A failed read throws. */
export interface RepairOrderReader {
  order(tenantId: string, orderId: string): Promise<RepairOrderRef | null>;
}

/** The reference from a case to an order of the workshop (SPECS §5.1 `IncidentRepairLink`). */
export interface RepairLink {
  readonly id: string;
  readonly tenantId: string;
  readonly incidentId: string;
  readonly orderId: string;
  readonly linkedAt: string;
  readonly linkedBy: string;
}

export type RepairChange =
  | { readonly kind: 'link'; readonly link: RepairLink }
  | {
      readonly kind: 'unlink';
      readonly tenantId: string;
      readonly incidentId: string;
      readonly linkId: string;
    };

export interface IncidentRepairStore {
  /** Oldest first. `tx` joins the transaction of a command (the ORM manager, or nothing in memory). */
  links(tenantId: string, incidentId: string, tx?: unknown): Promise<readonly RepairLink[]>;
  /** The link of an order in the tenant, whichever case holds it. */
  linkOfOrder(tenantId: string, orderId: string): Promise<RepairLink | null>;
  /** Links of the cases of the tenant that hold any of the orders (vehicle holds, D11). */
  linksOfOrders(tenantId: string, orderIds: readonly string[]): Promise<readonly RepairLink[]>;
  /**
   * Writes the incident mutation (version CAS, timeline, audit, outbox) and the link change in one
   * transaction. `applied: false` on a stale version, a taken idempotency key or an order that is
   * already linked in the tenant; nothing is written then.
   */
  apply(mutation: IncidentMutation, change: RepairChange): Promise<IncidentApplyResult>;
}
