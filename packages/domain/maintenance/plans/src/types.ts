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
  readonly state: 'scheduled' | 'completed' | 'closed' | 'cancelled';
}

export interface ScheduledMaintenanceOrder {
  readonly id: string;
  readonly tenantId: string;
  readonly occurrenceId: string;
  readonly planId: string;
  readonly vehicleId: string;
  readonly status: 'scheduled' | 'completed' | 'closed' | 'cancelled';
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
    /** IANA zone of the tenant for the calendar-day comparisons; UTC when omitted. */
    timeZone?: string,
  ): Promise<readonly PlanEvaluation[]>;
  /**
   * Queues one `maintenance.plan.scan` job per active plan of the tenant in the durable outbox.
   * The event id is deterministic per plan and hour of `now`, so repeated ticks inside the same
   * hour queue nothing new; returns the number of active plans considered.
   */
  enqueueScans(tenantId: string, now: Date): Promise<number>;
  closePreventive(event: PreventiveOrderClosedEvent): Promise<void>;
  /** Invalidates the closure of a reopened order and restores the pre-closure plan baseline. */
  reopenPreventive(event: PreventiveOrderLifecycleEvent): Promise<void>;
  /** Marks a cancelled order's occurrence cancelled (history kept) so the next scan reschedules it. */
  cancelPreventive(event: PreventiveOrderLifecycleEvent): Promise<void>;
  /** Records that the scheduled order was adopted into a work order. */
  adoptPreventive(event: PreventiveOrderLifecycleEvent): Promise<void>;
  /**
   * Plan service baseline excluding the closure of the occurrence while that closure is still
   * applied (the plan's current baseline otherwise); null when the plan is unknown. Used to
   * validate the re-completion of a reopened order.
   */
  baselineBeforeClosure(
    tenantId: string,
    planId: string,
    occurrenceId: string,
  ): Promise<{
    readonly lastServiceDate: string | null;
    readonly lastServiceKm: number | null;
  } | null>;
}

/** Ids and the order version the transition produced; the version orders events per occurrence. */
export interface PreventiveOrderLifecycleEvent {
  readonly tenantId: string;
  readonly planId: string;
  readonly occurrenceId: string;
  readonly orderId: string;
  readonly eventId: string;
  readonly version: number;
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
  /** Order version after the close; absent only on events queued before versioning. */
  readonly version?: number;
}

export interface VehicleMaintenanceReader {
  /** Returns null for unknown, archived, foreign, or inaccessible vehicles. */
  read(
    tenantId: string,
    vehicleId: string,
  ): Promise<{ readonly id: string; readonly odometer: OdometerReading } | null>;
}
