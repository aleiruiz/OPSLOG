import type { ISODateTime, Page } from '../index.js';
import type { BffRouteDefinition } from './shared.js';

export const BFF_VEHICLE_STATUSES = [
  'active',
  'restricted',
  'in_maintenance',
  'out_of_service',
  'inactive',
  'decommissioned',
] as const;
export type BffVehicleStatus = (typeof BFF_VEHICLE_STATUSES)[number];

/** A fleet vehicle. The company is implicit (the session's); `version` is the concurrency token. */
export interface BffVehicle {
  readonly id: string;
  readonly economicNumber: string;
  readonly plate: string;
  readonly vin: string | null;
  readonly make: string;
  readonly model: string;
  readonly year: number;
  readonly areaId: string;
  readonly status: BffVehicleStatus;
  readonly statusReason: string;
  readonly odometerKm: number;
  /** `YYYY-MM-DD`. */
  readonly registeredOn: string;
  readonly version: number;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
  readonly archivedAt: ISODateTime | null;
}

export interface BffVehicleInput {
  readonly economicNumber: string;
  readonly plate: string;
  readonly vin?: string | null;
  readonly make: string;
  readonly model: string;
  readonly year: number;
  readonly areaId: string;
  readonly odometerKm: number;
  /** `YYYY-MM-DD`, not in the future; defaults to today. */
  readonly registeredOn?: string;
}

/** Fields that can be edited in place; at least one besides `version`. Status and odometer have their own commands. */
export interface BffVehiclePatch {
  readonly version: number;
  readonly economicNumber?: string;
  readonly plate?: string;
  readonly vin?: string | null;
  readonly make?: string;
  readonly model?: string;
  readonly year?: number;
  readonly areaId?: string;
}

export interface BffVehiclesQuery {
  readonly limit?: 25 | 50 | 100;
  readonly cursor?: string;
  readonly status?: BffVehicleStatus;
  readonly areaId?: string;
  /** `true` to include archived vehicles (default: hidden). */
  readonly includeArchived?: 'true' | 'false';
}

export interface BffVehicleStatusEntry {
  readonly id: string;
  readonly from: BffVehicleStatus | null;
  readonly to: BffVehicleStatus;
  readonly reason: string;
  readonly actorId: string;
  readonly version: number;
  readonly at: ISODateTime;
}

/** Request and response types of the vehicles routes. */
export interface VehiclesRouteTypes {
  'vehicles.list': { query?: BffVehiclesQuery; response: Page<BffVehicle> };
  'vehicles.create': { body: BffVehicleInput; response: BffVehicle };
  'vehicles.get': { params: { id: string }; response: BffVehicle };
  'vehicles.update': { params: { id: string }; body: BffVehiclePatch; response: BffVehicle };
  'vehicles.status': {
    params: { id: string };
    body: { version: number; status: BffVehicleStatus; reason: string };
    response: BffVehicle;
  };
  'vehicles.odometer': {
    params: { id: string };
    body: { version: number; odometerKm: number };
    response: BffVehicle;
  };
  'vehicles.archive': { params: { id: string }; body: { version: number }; response: BffVehicle };
  'vehicles.history': {
    params: { id: string };
    response: { items: readonly BffVehicleStatusEntry[] };
  };
}

export const VEHICLES_ROUTES = {
  'vehicles.list': { method: 'GET', path: ['api', 'vehicles'], kind: 'session', status: 200 },
  'vehicles.create': {
    method: 'POST',
    path: ['api', 'vehicles'],
    kind: 'session-csrf',
    status: 201,
  },
  'vehicles.get': {
    method: 'GET',
    path: ['api', 'vehicles', ':id'],
    kind: 'session',
    status: 200,
  },
  'vehicles.update': {
    method: 'PUT',
    path: ['api', 'vehicles', ':id'],
    kind: 'session-csrf',
    status: 200,
  },
  'vehicles.status': {
    method: 'POST',
    path: ['api', 'vehicles', ':id', 'status'],
    kind: 'session-csrf',
    status: 200,
  },
  'vehicles.odometer': {
    method: 'POST',
    path: ['api', 'vehicles', ':id', 'odometer'],
    kind: 'session-csrf',
    status: 200,
  },
  'vehicles.archive': {
    method: 'POST',
    path: ['api', 'vehicles', ':id', 'archive'],
    kind: 'session-csrf',
    status: 200,
  },
  'vehicles.history': {
    method: 'GET',
    path: ['api', 'vehicles', ':id', 'history'],
    kind: 'session',
    status: 200,
  },
} as const satisfies Record<keyof VehiclesRouteTypes, BffRouteDefinition>;
