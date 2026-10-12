export type PlanState = 'active' | 'paused';
export type Trigger = 'date' | 'odometer';
export type AlertKind = 'upcoming' | 'due' | 'overdue';
export type Threshold = '15_days' | '500_km' | 'target';

export interface PlanInput {
  readonly vehicleId: string;
  readonly intervalDays?: number;
  readonly intervalKm?: number;
  readonly lastServiceDate?: string;
  readonly lastServiceKm?: number;
  readonly defaultWorkshopId?: string | null;
  readonly defaultMechanicId?: string | null;
}

export interface MaintenancePlan extends PlanInput {
  readonly id: string;
  readonly tenantId: string;
  readonly state: PlanState;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PlanOccurrence {
  readonly id: string;
  readonly tenantId: string;
  readonly planId: string;
  readonly sequence: number;
  readonly planVersion: number;
  readonly trigger: Trigger;
  readonly targetDate: string | null;
  readonly targetKm: number | null;
  readonly detectedAt: string;
  readonly orderId: string;
  readonly workshopId: string | null;
  readonly mechanicId: string | null;
  readonly state: 'scheduled' | 'completed' | 'closed';
}

export interface ScheduledMaintenanceOrder {
  readonly id: string;
  readonly tenantId: string;
  readonly occurrenceId: string;
  readonly planId: string;
  readonly vehicleId: string;
  readonly status: 'scheduled' | 'completed' | 'closed';
  readonly kind: 'preventive';
  readonly snapshot: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface MaintenancePlanSchedule {
  readonly planId: string;
  readonly nextTargetDate: string | null;
  readonly nextTargetKm: number | null;
  readonly occurrence: PlanOccurrence | null;
  readonly order: ScheduledMaintenanceOrder | null;
}

export interface PlanScheduleReader {
  readSchedule(tenantId: string, planId: string): Promise<MaintenancePlanSchedule>;
  listScheduledOrders(
    tenantId: string,
    planId: string,
  ): Promise<readonly ScheduledMaintenanceOrder[]>;
}

/** An in-app alert persisted by the plans worker; `vehicleId` is the plan's vehicle. */
export interface PlanAlertRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly planId: string;
  readonly vehicleId: string;
  readonly occurrence: number;
  readonly planVersion: number;
  readonly kind: AlertKind;
  readonly trigger: Trigger;
  readonly threshold: Threshold;
  readonly targetDate: string | null;
  readonly targetKm: number | null;
  readonly odometerLastUpdatedAt: string | null;
  readonly odometerAgeSeconds: number | null;
  readonly occurredAt: string;
}
export interface PlanAlertQuery {
  readonly planId?: string;
  readonly vehicleId?: string;
  readonly limit: number;
  readonly offset: number;
}
export interface PlanAlertPage {
  readonly items: readonly PlanAlertRecord[];
  readonly total: number;
}
export interface PlanAlertReader {
  /** Newest first (`occurredAt`, then id); every selector includes the tenant. */
  listAlerts(tenantId: string, query: PlanAlertQuery): Promise<PlanAlertPage>;
}

export interface OdometerReading {
  readonly km: number;
  /** Null means M2 has no persisted reading timestamp yet; km targets must not advance on it. */
  readonly updatedAt: string | null;
}

export interface PlanEvaluation {
  readonly kind: AlertKind;
  readonly trigger: Trigger;
  readonly threshold: Threshold;
  readonly occurrence: number;
  readonly planVersion: number;
  readonly targetDate: string | null;
  readonly targetKm: number | null;
  readonly occurredAt: string;
  readonly odometerLastUpdatedAt?: string;
  readonly odometerAgeSeconds?: number;
}

export interface PlanCreateContext {
  readonly tenantId: string;
  readonly actorId: string;
  readonly vehicleId: string;
}

export interface PlanStore {
  create(plan: MaintenancePlan, actorId: string): Promise<MaintenancePlan>;
  get(tenantId: string, id: string): Promise<MaintenancePlan | null>;
  list(tenantId: string): Promise<readonly MaintenancePlan[]>;
  update(plan: MaintenancePlan, expectedVersion: number, actorId: string): Promise<boolean>;
  nextSequence(tenantId: string, planId: string): Promise<number>;
}

export interface PlanScanStore {
  /** Claims and commits one scan under a durable row lock; callers may safely retry it. */
  scan(
    tenantId: string,
    planId: string,
    now: Date,
    odometer: OdometerReading,
  ): Promise<readonly PlanEvaluation[]>;
  closePreventive(event: PreventiveOrderClosedEvent): Promise<void>;
}

export interface PreventiveOrderClosedEvent {
  readonly tenantId: string;
  readonly planId: string;
  readonly occurrenceId: string;
  readonly orderId: string;
  readonly kind: 'preventive' | 'corrective';
  readonly eventId: string;
  readonly completedAt: string;
  readonly actualDate: string;
  readonly actualKm: number;
}

export interface VehicleMaintenanceReader {
  /** Returns null for unknown, archived, foreign, or inaccessible vehicles. */
  read(
    tenantId: string,
    vehicleId: string,
  ): Promise<{ readonly id: string; readonly odometer: OdometerReading } | null>;
}
