import type { ISODateTime } from '../index.js';
import type { BffRouteDefinition } from './shared.js';

export type BffWorkOrderStatus =
  | 'scheduled'
  | 'assigned'
  | 'in_progress'
  | 'completed'
  | 'closed'
  | 'cancelled';
export type BffWorkOrderCommand =
  | 'assign'
  | 'start'
  | 'complete'
  | 'approve_close'
  | 'close'
  | 'cancel'
  | 'reopen';
/** Exact amount in the minor unit as a decimal string, with its ISO 4217 currency. */
export interface BffMoney {
  readonly amountMinor: string;
  readonly currency: string;
}
export interface BffWorkOrderPart {
  readonly id: string;
  readonly name: string;
  readonly quantity: string;
  /** Only for callers with `view_costs`. */
  readonly unitCost?: BffMoney | null;
}
export interface BffWorkOrderCost {
  readonly id: string;
  readonly category: 'labor' | 'parts' | 'external_service' | 'other';
  readonly amount: BffMoney;
}
export interface BffWorkOrder {
  readonly id: string;
  readonly kind: 'preventive' | 'corrective';
  readonly vehicleId: string;
  readonly planId: string | null;
  readonly occurrenceId: string | null;
  readonly status: BffWorkOrderStatus;
  readonly version: number;
  readonly description: string | null;
  readonly responsibleId: string | null;
  readonly workshopId: string | null;
  readonly mechanicId: string | null;
  readonly scheduledDate: string | null;
  readonly requiresWorkshop: boolean;
  readonly startedAt: ISODateTime | null;
  readonly completedAt: ISODateTime | null;
  readonly actualDate: string | null;
  readonly actualKm: number | null;
  readonly tasks: readonly { readonly id: string; readonly description: string }[];
  readonly parts: readonly BffWorkOrderPart[];
  /** Only for callers with `view_costs`. */
  readonly costs?: readonly BffWorkOrderCost[];
  readonly closeApproval: { readonly approvedBy: string; readonly approvedAt: ISODateTime } | null;
  readonly closedAt: ISODateTime | null;
  readonly closedBy: string | null;
  readonly vehicleStatusDecision: string | null;
  readonly cancelReason: string | null;
  readonly reopenCount: number;
  /** A suggestion while a workshop episode is open; the vehicle status is never changed for you. */
  readonly vehicleProposal: {
    readonly suggestedStatus: 'in_maintenance';
    readonly eligibilityBlocked: true;
  } | null;
  readonly createdAt: ISODateTime;
  readonly createdBy: string;
  readonly updatedAt: ISODateTime;
  readonly updatedBy: string;
}
export interface BffWorkOrderTransition {
  readonly orderId: string;
  readonly sequence: number;
  readonly command: BffWorkOrderCommand | 'create';
  readonly from: BffWorkOrderStatus | null;
  readonly to: BffWorkOrderStatus;
  readonly actorId: string;
  readonly comment: string | null;
  readonly occurredAt: ISODateTime;
  readonly before: Readonly<Record<string, unknown>> | null;
}
/** A transition command: `version` plus the fields its SPECS §6.1 requirements need. */
export interface BffWorkOrderTransitionInput {
  readonly command: BffWorkOrderCommand;
  readonly version: number;
  readonly responsibleId?: string;
  readonly workshopId?: string | null;
  readonly mechanicId?: string | null;
  readonly scheduledDate?: string;
  readonly requiresWorkshop?: boolean;
  readonly actualDate?: string;
  readonly actualKm?: number;
  readonly vehicleStatus?:
    | 'active'
    | 'restricted'
    | 'in_maintenance'
    | 'out_of_service'
    | 'inactive';
  readonly comment?: string;
  readonly reason?: string;
}
export interface BffWorkOrderWorkInput {
  readonly version: number;
  readonly description?: string | null;
  readonly tasks?: readonly { readonly id?: string; readonly description: string }[];
  readonly parts?: readonly {
    readonly id?: string;
    readonly name: string;
    readonly quantity: string;
  }[];
}
export interface BffWorkOrderCostsInput {
  readonly version: number;
  readonly costs?: readonly {
    readonly id?: string;
    readonly category: BffWorkOrderCost['category'];
    readonly amount: BffMoney;
  }[];
  readonly partCosts?: readonly { readonly partId: string; readonly unitCost: BffMoney | null }[];
}

export interface WorkOrderRouteTypes {
  'workOrders.list': { response: readonly BffWorkOrder[] };
  'workOrders.create': {
    body: { readonly vehicleId: string; readonly description: string };
    response: BffWorkOrder;
  };
  'workOrders.adopt': {
    body: { readonly planId: string; readonly scheduledOrderId: string };
    response: BffWorkOrder;
  };
  'workOrders.get': { params: { orderId: string }; response: BffWorkOrder };
  'workOrders.history': {
    params: { orderId: string };
    response: readonly BffWorkOrderTransition[];
  };
  'workOrders.transition': {
    params: { orderId: string };
    body: BffWorkOrderTransitionInput;
    response: BffWorkOrder;
  };
  'workOrders.work': {
    params: { orderId: string };
    body: BffWorkOrderWorkInput;
    response: BffWorkOrder;
  };
  'workOrders.costs': {
    params: { orderId: string };
    body: BffWorkOrderCostsInput;
    response: BffWorkOrder;
  };
}

const orders = ['api', 'v1', 'work-orders'] as const;
export const WORK_ORDER_ROUTES = {
  'workOrders.list': { method: 'GET', path: orders, kind: 'session', status: 200 },
  'workOrders.create': { method: 'POST', path: orders, kind: 'session-csrf', status: 201 },
  'workOrders.adopt': {
    method: 'POST',
    path: [...orders, 'preventive'],
    kind: 'session-csrf',
    status: 201,
  },
  'workOrders.get': { method: 'GET', path: [...orders, ':orderId'], kind: 'session', status: 200 },
  'workOrders.history': {
    method: 'GET',
    path: [...orders, ':orderId', 'history'],
    kind: 'session',
    status: 200,
  },
  'workOrders.transition': {
    method: 'POST',
    path: [...orders, ':orderId', 'transitions'],
    kind: 'session-csrf',
    status: 200,
  },
  'workOrders.work': {
    method: 'PUT',
    path: [...orders, ':orderId', 'work'],
    kind: 'session-csrf',
    status: 200,
  },
  'workOrders.costs': {
    method: 'PUT',
    path: [...orders, ':orderId', 'costs'],
    kind: 'session-csrf',
    status: 200,
  },
} as const satisfies Record<keyof WorkOrderRouteTypes, BffRouteDefinition>;
