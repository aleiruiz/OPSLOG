import type { ISODateTime, Page } from '../index.js';
import type { BffRouteDefinition } from './shared.js';

export interface BffMaintenancePlan {
  readonly id: string;
  readonly vehicleId: string;
  readonly state: 'active' | 'paused';
  readonly intervalDays?: number;
  readonly intervalKm?: number;
  readonly lastServiceDate?: string;
  readonly lastServiceKm?: number;
  readonly defaultWorkshopId: string | null;
  readonly defaultMechanicId: string | null;
  readonly version: number;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
}
export type BffMaintenancePlanInput = Pick<BffMaintenancePlan, 'vehicleId'> &
  Partial<
    Pick<
      BffMaintenancePlan,
      | 'intervalDays'
      | 'intervalKm'
      | 'lastServiceDate'
      | 'lastServiceKm'
      | 'defaultWorkshopId'
      | 'defaultMechanicId'
    >
  >;
export type BffMaintenancePlanPatch = Omit<BffMaintenancePlanInput, 'vehicleId'> & {
  readonly version: number;
};
export interface BffMaintenancePlanOccurrence {
  readonly id: string;
  readonly planId: string;
  readonly sequence: number;
  readonly planVersion: number;
  readonly trigger: 'date' | 'odometer';
  readonly targetDate: string | null;
  readonly targetKm: number | null;
  readonly detectedAt: ISODateTime;
  readonly orderId: string;
  readonly workshopId: string | null;
  readonly mechanicId: string | null;
  readonly state: 'scheduled' | 'completed' | 'closed';
}
export interface BffScheduledMaintenanceOrder {
  readonly id: string;
  readonly occurrenceId: string;
  readonly planId: string;
  readonly vehicleId: string;
  readonly status: 'scheduled' | 'completed' | 'closed';
  readonly kind: 'preventive';
  readonly snapshot: Readonly<Record<string, unknown>>;
  readonly createdAt: ISODateTime;
}
export interface BffMaintenancePlanSchedule {
  readonly planId: string;
  readonly nextTargetDate: string | null;
  readonly nextTargetKm: number | null;
  readonly occurrence: BffMaintenancePlanOccurrence | null;
  readonly order: BffScheduledMaintenanceOrder | null;
}
export interface BffMaintenanceWorkshop {
  readonly id: string;
  readonly name: string;
  readonly specialties: readonly string[];
  readonly contact: string | null;
  readonly active: boolean;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
}
export type BffMaintenanceWorkshopInput = Pick<BffMaintenanceWorkshop, 'name' | 'specialties'> & {
  readonly contact?: string | null;
};
export interface BffMaintenanceMechanic {
  readonly id: string;
  readonly name: string;
  readonly specialties: readonly string[];
  readonly contact: string | null;
  readonly kind: 'internal' | 'external';
  readonly workshopId: string | null;
  readonly memberId: string | null;
  readonly active: boolean;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
}
export type BffMaintenanceMechanicInput = Pick<
  BffMaintenanceMechanic,
  'name' | 'specialties' | 'kind'
> & {
  readonly contact?: string | null;
  readonly workshopId?: string | null;
  readonly memberId?: string | null;
};

/**
 * An in-app record the plans worker persisted when a plan crossed a threshold (SPECS §7: 15 days,
 * 500 km, due, overdue). `odometerAgeSeconds` is how old the odometer reading was at detection and
 * only exists for odometer triggers; the company is implicit.
 */
export interface BffMaintenanceAlert {
  readonly id: string;
  readonly planId: string;
  readonly vehicleId: string;
  readonly occurrence: number;
  readonly planVersion: number;
  readonly kind: 'upcoming' | 'due' | 'overdue';
  readonly trigger: 'date' | 'odometer';
  readonly threshold: '15_days' | '500_km' | 'target';
  readonly targetDate: string | null;
  readonly targetKm: number | null;
  readonly odometerLastUpdatedAt: ISODateTime | null;
  readonly odometerAgeSeconds: number | null;
  readonly occurredAt: ISODateTime;
}
/** Newest first. `planId` and `vehicleId` narrow the list; the same visibility as the plans catalog applies. */
export interface BffMaintenanceAlertsQuery {
  readonly limit?: 25 | 50 | 100;
  readonly cursor?: string;
  readonly planId?: string;
  readonly vehicleId?: string;
}

export interface MaintenanceRouteTypes {
  'maintenance.alerts.list': {
    query?: BffMaintenanceAlertsQuery;
    response: Page<BffMaintenanceAlert>;
  };
  'maintenance.plans.list': { response: readonly BffMaintenancePlan[] };
  'maintenance.plans.create': { body: BffMaintenancePlanInput; response: BffMaintenancePlan };
  'maintenance.plans.get': { params: { planId: string }; response: BffMaintenancePlan };
  'maintenance.plans.schedule': {
    params: { planId: string };
    response: BffMaintenancePlanSchedule;
  };
  'maintenance.plans.orders': {
    params: { planId: string };
    response: readonly BffScheduledMaintenanceOrder[];
  };
  'maintenance.plans.update': {
    params: { planId: string };
    body: BffMaintenancePlanPatch;
    response: BffMaintenancePlan;
  };
  'maintenance.plans.pause': {
    params: { planId: string };
    body: { version: number };
    response: BffMaintenancePlan;
  };
  'maintenance.plans.resume': {
    params: { planId: string };
    body: { version: number };
    response: BffMaintenancePlan;
  };
  'maintenance.workshops.list': { response: readonly BffMaintenanceWorkshop[] };
  'maintenance.workshops.create': {
    body: BffMaintenanceWorkshopInput;
    response: BffMaintenanceWorkshop;
  };
  'maintenance.workshops.get': { params: { workshopId: string }; response: BffMaintenanceWorkshop };
  'maintenance.workshops.update': {
    params: { workshopId: string };
    body: BffMaintenanceWorkshopInput;
    response: BffMaintenanceWorkshop;
  };
  'maintenance.workshops.deactivate': {
    params: { workshopId: string };
    response: BffMaintenanceWorkshop;
  };
  'maintenance.mechanics.list': { response: readonly BffMaintenanceMechanic[] };
  'maintenance.mechanics.create': {
    body: BffMaintenanceMechanicInput;
    response: BffMaintenanceMechanic;
  };
  'maintenance.mechanics.get': { params: { mechanicId: string }; response: BffMaintenanceMechanic };
  'maintenance.mechanics.update': {
    params: { mechanicId: string };
    body: BffMaintenanceMechanicInput;
    response: BffMaintenanceMechanic;
  };
  'maintenance.mechanics.deactivate': {
    params: { mechanicId: string };
    response: BffMaintenanceMechanic;
  };
}

const plans = ['api', 'v1', 'maintenance', 'plans'] as const;
const alerts = ['api', 'v1', 'maintenance', 'alerts'] as const;
const workshops = ['api', 'v1', 'maintenance', 'workshops'] as const;
const mechanics = ['api', 'v1', 'maintenance', 'mechanics'] as const;
export const MAINTENANCE_ROUTES = {
  'maintenance.alerts.list': { method: 'GET', path: alerts, kind: 'session', status: 200 },
  'maintenance.plans.list': { method: 'GET', path: plans, kind: 'session', status: 200 },
  'maintenance.plans.create': { method: 'POST', path: plans, kind: 'session-csrf', status: 201 },
  'maintenance.plans.get': {
    method: 'GET',
    path: [...plans, ':planId'],
    kind: 'session',
    status: 200,
  },
  'maintenance.plans.schedule': {
    method: 'GET',
    path: [...plans, ':planId', 'schedule'],
    kind: 'session',
    status: 200,
  },
  'maintenance.plans.orders': {
    method: 'GET',
    path: [...plans, ':planId', 'orders'],
    kind: 'session',
    status: 200,
  },
  'maintenance.plans.update': {
    method: 'PUT',
    path: [...plans, ':planId'],
    kind: 'session-csrf',
    status: 200,
  },
  'maintenance.plans.pause': {
    method: 'POST',
    path: [...plans, ':planId', 'pause'],
    kind: 'session-csrf',
    status: 200,
  },
  'maintenance.plans.resume': {
    method: 'POST',
    path: [...plans, ':planId', 'resume'],
    kind: 'session-csrf',
    status: 200,
  },
  'maintenance.workshops.list': { method: 'GET', path: workshops, kind: 'session', status: 200 },
  'maintenance.workshops.create': {
    method: 'POST',
    path: workshops,
    kind: 'session-csrf',
    status: 201,
  },
  'maintenance.workshops.get': {
    method: 'GET',
    path: [...workshops, ':workshopId'],
    kind: 'session',
    status: 200,
  },
  'maintenance.workshops.update': {
    method: 'PUT',
    path: [...workshops, ':workshopId'],
    kind: 'session-csrf',
    status: 200,
  },
  'maintenance.workshops.deactivate': {
    method: 'POST',
    path: [...workshops, ':workshopId', 'deactivate'],
    kind: 'session-csrf',
    status: 200,
  },
  'maintenance.mechanics.list': { method: 'GET', path: mechanics, kind: 'session', status: 200 },
  'maintenance.mechanics.create': {
    method: 'POST',
    path: mechanics,
    kind: 'session-csrf',
    status: 201,
  },
  'maintenance.mechanics.get': {
    method: 'GET',
    path: [...mechanics, ':mechanicId'],
    kind: 'session',
    status: 200,
  },
  'maintenance.mechanics.update': {
    method: 'PUT',
    path: [...mechanics, ':mechanicId'],
    kind: 'session-csrf',
    status: 200,
  },
  'maintenance.mechanics.deactivate': {
    method: 'POST',
    path: [...mechanics, ':mechanicId', 'deactivate'],
    kind: 'session-csrf',
    status: 200,
  },
} as const satisfies Record<keyof MaintenanceRouteTypes, BffRouteDefinition>;
