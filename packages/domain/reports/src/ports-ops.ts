import type { Amount } from './money.js';
import type { ReportContext } from './types.js';

/** Who is asking: the sources scope by person (D9) and gate money by permission. */
export type ReportReader = Pick<ReportContext, 'tenantId' | 'permissions' | 'actorId'>;

export type WorkOrderCostCategory = 'labor' | 'parts' | 'external_service' | 'other';

export interface WorkOrderFact {
  readonly id: string;
  readonly kind: 'preventive' | 'corrective';
  readonly vehicleId: string;
  readonly planId: string | null;
  readonly status: string;
  readonly description: string | null;
  /** The name the screens show, never the id. */
  readonly workshop: string | null;
  readonly scheduledDate: string | null;
  readonly actualDate: string | null;
  readonly actualKm: number | null;
  /** Targets the plan set for this occurrence (preventive orders). */
  readonly targetDate: string | null;
  readonly targetKm: number | null;
  readonly createdAt: string;
  readonly closedAt: string | null;
  readonly reopenCount: number;
  /** Folio of the case that repairs through this order; only for readers of incidents. */
  readonly incidentFolio: string | null;
  /** Present only when the read asked for costs (`view_costs`). */
  readonly costs?: readonly (Amount & { readonly category: WorkOrderCostCategory })[];
}

export interface PlanFact {
  readonly id: string;
  readonly vehicleId: string;
  readonly state: 'active' | 'paused';
  readonly intervalDays: number | null;
  readonly intervalKm: number | null;
  readonly nextTargetDate: string | null;
}

export interface IncidentFact {
  readonly id: string;
  readonly folio: string;
  readonly type: string;
  readonly severity: string | null;
  readonly status: string;
  readonly cycle: number;
  readonly reopenCount: number;
  readonly vehicleId: string;
  readonly driverId: string | null;
  readonly areaId: string;
  readonly occurredOn: string | null;
  readonly reportedAt: string | null;
  readonly resolvedAt: string | null;
  readonly closedAt: string | null;
  readonly totalLoss: boolean | null;
  readonly coverageStatus: string;
}

/** Costs of one case in one currency, as INC-COSTS totals them (linked orders counted once). */
export interface IncidentCostFact {
  readonly currency: string;
  /** Costs of the linked, non-cancelled orders. */
  readonly repairs: string;
  /** Own expense lines by category (repair without an order, deductible, towing, ...). */
  readonly expensesByCategory: Readonly<Record<string, string>>;
  readonly expenses: string;
  readonly recoveries: string;
  readonly companyBorne: string;
}

export interface IncidentStepFact {
  readonly command: string;
  readonly to: string;
  readonly at: string;
}

export interface IncidentSlaFact {
  readonly state: string;
  readonly cycle: number;
  readonly startedAt: string | null;
  readonly deadline: string | null;
  readonly targetDays: number | null;
  readonly resolvedAt: string | null;
  readonly previousCycles: readonly {
    readonly cycle: number;
    readonly startedAt: string;
    readonly resolvedAt: string | null;
    readonly met: boolean;
  }[];
}

export interface AssignmentHistoryFact {
  readonly vehicleId: string;
  readonly employeeId: string;
  readonly type: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
}

export interface StatusChangeFact {
  readonly to: string;
  readonly at: string;
}

export interface AuditFact {
  readonly occurredAt: string;
  readonly actionLabel: string;
  readonly result: 'success' | 'denied';
  readonly entityType: string;
  readonly entityTypeLabel: string;
  readonly entityLabel: string;
  readonly actorLabel: string;
  readonly actorAlias: string;
  readonly correlationId: string;
  /** Changed fields as the audit screen masks them for this reader; null when none is recorded. */
  readonly changes: string | null;
}

export interface AuditRange {
  readonly from: string;
  readonly to: string;
  readonly entityType?: string;
  readonly result?: 'success' | 'denied';
  readonly action?: string;
}

/**
 * Reads of the maintenance, incident, audit and history reports. Every method names the reader: a
 * mechanic-scoped member gets nothing (D9), and money comes only for the permission that protects it.
 */
export interface OperationalSources {
  /** Orders of the company (of one vehicle when named); costs only with `withCosts` and `view_costs`. */
  workOrders(
    reader: ReportReader,
    options: { readonly vehicleId?: string; readonly withCosts: boolean },
  ): Promise<readonly WorkOrderFact[]>;
  plans(reader: ReportReader): Promise<readonly PlanFact[]>;
  /** Cases past `draft`, of one vehicle or driver when named. */
  incidents(
    reader: ReportReader,
    options: { readonly vehicleId?: string; readonly driverId?: string },
  ): Promise<readonly IncidentFact[]>;
  /** Costs by case; empty without `incidents:view_costs`. */
  incidentCosts(
    reader: ReportReader,
    incidentIds: readonly string[],
  ): Promise<ReadonlyMap<string, readonly IncidentCostFact[]>>;
  /** State entries of each case, oldest first. */
  incidentSteps(
    reader: ReportReader,
    incidentIds: readonly string[],
  ): Promise<ReadonlyMap<string, readonly IncidentStepFact[]>>;
  incidentSla(
    reader: ReportReader,
    incidentIds: readonly string[],
  ): Promise<ReadonlyMap<string, IncidentSlaFact>>;
  /** Every assignment of a vehicle or of a driver, current or ended. */
  assignmentHistory(
    tenantId: string,
    scope: { readonly vehicleId?: string; readonly employeeId?: string },
  ): Promise<readonly AssignmentHistoryFact[]>;
  /** Status changes of one vehicle, oldest first. */
  statusHistory(tenantId: string, vehicleId: string): Promise<readonly StatusChangeFact[]>;
  /** The audit trail of a range, masked as the audit screen masks it for this reader. */
  auditLog(reader: ReportReader, range: AuditRange): Promise<readonly AuditFact[]>;
}
