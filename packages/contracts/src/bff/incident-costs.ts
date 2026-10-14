import type { ISODateTime } from '../index.js';
import type { BffIncidentPerson } from './incidents.js';
import type { BffRouteDefinition } from './shared.js';
import type { BffMoney } from './work-orders.js';

/** Kinds and categories of the own cost lines of a case (INC-COSTS). There is no driver as payer (D15). */
export const BFF_COST_KINDS = ['expense', 'recovery'] as const;
export type BffCostKind = (typeof BFF_COST_KINDS)[number];
export const BFF_EXPENSE_CATEGORIES = [
  'repair',
  'deductible',
  'towing',
  'fine',
  'third_party_damage',
  'legal',
  'other',
] as const;
export const BFF_RECOVERY_CATEGORIES = ['insurer', 'third_party', 'other'] as const;
export type BffCostCategory =
  | (typeof BFF_EXPENSE_CATEGORIES)[number]
  | (typeof BFF_RECOVERY_CATEGORIES)[number];
/** Most lines a case keeps. */
export const BFF_COST_MAX_LINES = 50;

/** The order a link points to. Never an amount: the costs of an order are in the case's `costs`. */
export interface BffRepairOrder {
  readonly id: string;
  readonly description: string | null;
  readonly status: 'scheduled' | 'assigned' | 'in_progress' | 'completed' | 'closed' | 'cancelled';
  /** The name of the workshop; `null` when the order has none. */
  readonly workshop: string | null;
}
export interface BffRepairLink {
  readonly id: string;
  readonly orderId: string;
  readonly order: BffRepairOrder;
  readonly linkedAt: ISODateTime;
  readonly linkedBy: BffIncidentPerson;
}
export interface BffRepairLinkList {
  readonly items: readonly BffRepairLink[];
}
export interface BffRepairLinkChange {
  /** The version of the case after the command: what the next command sends. */
  readonly version: number;
  readonly item: BffRepairLink;
}
export interface BffRepairUnlink {
  readonly version: number;
}
export interface BffRepairLinkInput {
  readonly version: number;
  readonly orderId: string;
}
export interface BffRepairUnlinkInput {
  readonly version: number;
}

export interface BffCostLine {
  readonly id: string;
  readonly kind: BffCostKind;
  readonly category: BffCostCategory;
  readonly amount: BffMoney;
  readonly note: string | null;
}
/** A line to save. An `id` must name a line the case already has; without one the server assigns it. */
export interface BffCostLineInput {
  readonly id?: string;
  readonly kind: BffCostKind;
  readonly category: BffCostCategory;
  readonly amount: BffMoney;
  readonly note?: string | null;
}
/** What the company bears in one currency: repairs plus expenses minus recoveries. May be negative. */
export interface BffCurrencyTotals {
  readonly currency: string;
  readonly repairs: string;
  readonly expenses: string;
  readonly recoveries: string;
  readonly companyBorne: string;
}
export type BffPolicyDeductible =
  | { readonly kind: 'amount'; readonly amountMinor: string; readonly currency: string }
  /** A percentage is shown as insurance keeps it; it is never turned into an amount. */
  | { readonly kind: 'percent'; readonly basisPoints: number };
export interface BffCostSnapshot {
  readonly cycle: number;
  readonly closedAt: ISODateTime;
  readonly totals: readonly BffCurrencyTotals[];
  readonly orders: readonly {
    readonly orderId: string;
    readonly version: number;
    readonly status: string;
  }[];
}
/** Costs of a case. Only for callers with `incidents:view_costs`; everyone else gets 403 and no amount. */
export interface BffIncidentCosts {
  /** The version of the case: what the next `PUT` sends. */
  readonly version: number;
  readonly lines: readonly BffCostLine[];
  /** Informative, outside every total. */
  readonly initialEstimate: BffMoney | null;
  /** The costs of each linked order, read from the workshop and never copied. */
  readonly repairs: readonly {
    readonly linkId: string;
    readonly orderId: string;
    readonly totals: readonly BffMoney[];
  }[];
  /** One row per currency; currencies are never added together (BR-027). */
  readonly totals: readonly BffCurrencyTotals[];
  readonly mixedCurrencies: boolean;
  readonly policyDeductible: BffPolicyDeductible | null;
  /** Present (`true`) only when the policy could not be read; the totals are unaffected. */
  readonly policyDeductibleUnavailable?: true;
  readonly snapshots: readonly BffCostSnapshot[];
  /** A linked order or a total is not what the last closure kept. */
  readonly differsFromLastClosure: boolean;
}
/** Replaces the lines. `initialEstimate` absent keeps it, `null` clears it. */
export interface BffIncidentCostsInput {
  readonly version: number;
  readonly lines: readonly BffCostLineInput[];
  readonly initialEstimate?: BffMoney | null;
}

export interface IncidentCostRouteTypes {
  'incidents.repairs.list': {
    params: { incidentId: string };
    response: BffRepairLinkList;
  };
  'incidents.repairs.link': {
    params: { incidentId: string };
    body: BffRepairLinkInput;
    /** The `Idempotency-Key` header is mandatory (400 `idempotency_key_required` without it). */
    idempotencyKey: string;
    response: BffRepairLinkChange;
  };
  'incidents.repairs.unlink': {
    params: { incidentId: string; linkId: string };
    body: BffRepairUnlinkInput;
    idempotencyKey: string;
    response: BffRepairUnlink;
  };
  'incidents.costs.get': {
    params: { incidentId: string };
    response: BffIncidentCosts;
  };
  'incidents.costs.update': {
    params: { incidentId: string };
    body: BffIncidentCostsInput;
    idempotencyKey: string;
    response: BffIncidentCosts;
  };
}

const incident = ['api', 'v1', 'incidents', ':incidentId'] as const;
export const INCIDENT_COST_ROUTES = {
  'incidents.repairs.list': {
    method: 'GET',
    path: [...incident, 'repairs'],
    kind: 'session',
    status: 200,
  },
  'incidents.repairs.link': {
    method: 'POST',
    path: [...incident, 'repairs'],
    kind: 'session-csrf',
    status: 200,
    idempotency: { requiredFor: [] },
  },
  'incidents.repairs.unlink': {
    method: 'POST',
    path: [...incident, 'repairs', ':linkId', 'unlink'],
    kind: 'session-csrf',
    status: 200,
    idempotency: { requiredFor: [] },
  },
  'incidents.costs.get': {
    method: 'GET',
    path: [...incident, 'costs'],
    kind: 'session',
    status: 200,
  },
  'incidents.costs.update': {
    method: 'PUT',
    path: [...incident, 'costs'],
    kind: 'session-csrf',
    status: 200,
    idempotency: { requiredFor: [] },
  },
} as const satisfies Record<keyof IncidentCostRouteTypes, BffRouteDefinition>;
