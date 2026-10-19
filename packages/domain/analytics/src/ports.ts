/** The vocabularies of the source modules, repeated so the dashboard depends on none of them. */
export type VehicleStatus =
  | 'active'
  | 'restricted'
  | 'in_maintenance'
  | 'out_of_service'
  | 'inactive'
  | 'decommissioned';
export type EmployeeKind = 'driver' | 'dispatcher' | 'other';
export type EmployeeStatus = 'active' | 'inactive' | 'suspended' | 'terminated';
export type IncidentSeverity = 'low' | 'medium' | 'high' | 'critical';

/**
 * Read ports of the dashboard. Each one is an aggregate read of a module that names the tenant in
 * every call and returns only what a formula needs (ids, dates, statuses, counts): no plate, name,
 * document number, policy number or free text ever crosses them. `areaIds` is the area filter with
 * its descendants already expanded; `null` means the whole company.
 */

export interface CompanyParameters {
  /** IANA zone of the company: "today" and every range day are days of this zone. */
  readonly timeZone: string;
  /** Days before the last valid day in which a document or policy is "por vencer" (1 to 30). */
  readonly expiryWindowDays: number;
}

export interface VehicleFact {
  readonly id: string;
  readonly areaId: string;
  readonly status: VehicleStatus;
  readonly odometerKm: number;
  /** Null when the reading has no timestamp: it does not count as a reading for the km threshold. */
  readonly odometerUpdatedAt: string | null;
  /** Instant it was archived; null while it lives. */
  readonly archivedAt: string | null;
}

export interface StatusEntryFact {
  readonly vehicleId: string;
  readonly to: VehicleStatus;
  /** UTC instant of the change. */
  readonly at: string;
}

export interface EmployeeFact {
  readonly id: string;
  readonly kind: EmployeeKind;
  readonly status: EmployeeStatus;
}

export interface FleetSource {
  /**
   * Vehicles of the areas that are not archived, plus the ones archived at or after `archivedSince`
   * (an instant), which were alive during the range.
   */
  vehicles(
    tenantId: string,
    areaIds: readonly string[] | null,
    archivedSince: string,
  ): Promise<readonly VehicleFact[]>;
  /** Status changes of the vehicles up to `until` (inclusive), oldest first. */
  statusEntries(
    tenantId: string,
    vehicleIds: readonly string[],
    until: string,
  ): Promise<readonly StatusEntryFact[]>;
  /** Employees of the areas that are not archived. */
  employees(tenantId: string, areaIds: readonly string[] | null): Promise<readonly EmployeeFact[]>;
}

/** The owners a document count is restricted to; `null` (no restriction) counts every owner. */
export interface OwnerScope {
  readonly vehicle: readonly string[];
  readonly employee: readonly string[];
}

export interface RequiredDocumentFact {
  readonly ownerType: 'vehicle' | 'employee';
  readonly ownerId: string;
  readonly typeCode: string;
}

export interface DocumentSource {
  /** Non-archived documents whose last valid day is within `[from, until]` (inclusive). */
  countExpiring(
    tenantId: string,
    window: { readonly from: string; readonly until: string },
    scope: OwnerScope | null,
  ): Promise<number>;
  /**
   * The distinct (owner, type) pairs, of the given types, that have a non-archived document whose
   * last valid day is `today` or later.
   */
  validRequired(
    tenantId: string,
    today: string,
    types: Readonly<Record<'vehicle' | 'employee', readonly string[]>>,
  ): Promise<readonly RequiredDocumentFact[]>;
}

export interface InsuranceSource {
  /** Non-archived policies whose last valid day is within `[from, until]` (inclusive). */
  countExpiring(
    tenantId: string,
    window: { readonly from: string; readonly until: string },
    vehicleIds: readonly string[] | null,
  ): Promise<number>;
  /** The vehicles, among `vehicleIds`, with a non-archived policy whose period includes `day`. */
  coveredVehicleIds(
    tenantId: string,
    day: string,
    vehicleIds: readonly string[],
  ): Promise<readonly string[]>;
}

export interface PlanFact {
  readonly vehicleId: string;
  /** `YYYY-MM-DD`; null when the plan has no interval in days. */
  readonly targetDate: string | null;
  /** Null when the plan has no interval in km. */
  readonly targetKm: number | null;
}

export interface ClosedOrderFact {
  readonly vehicleId: string;
  readonly kind: 'preventive' | 'corrective';
  readonly scheduledDate: string | null;
  readonly actualDate: string | null;
  readonly costs: readonly { readonly amountMinor: string; readonly currency: string }[];
}

export interface MaintenanceSource {
  /** The active plans of the tenant. */
  plans(tenantId: string): Promise<readonly PlanFact[]>;
  /** Orders closed in `[from, to)` (UTC instants). */
  closedOrders(
    tenantId: string,
    window: { readonly from: string; readonly to: string },
  ): Promise<readonly ClosedOrderFact[]>;
}

export interface OpenCaseFact {
  readonly severity: IncidentSeverity | null;
  /** The case is past its SLA deadline now. */
  readonly slaBreached: boolean;
}

export interface IncidentTimelineFact {
  readonly reportedAt: string | null;
  /** Resolution of the first cycle; null while the first cycle is unresolved. */
  readonly firstResolvedAt: string | null;
  readonly closedAt: string | null;
}

export interface IncidentSource {
  /** The open cases (not draft, closed or cancelled) of the areas. */
  openCases(tenantId: string, areaIds: readonly string[] | null): Promise<readonly OpenCaseFact[]>;
  /** The cases reported, first resolved or closed in `[from, to)` (UTC instants). */
  timeline(
    tenantId: string,
    areaIds: readonly string[] | null,
    window: { readonly from: string; readonly to: string },
  ): Promise<readonly IncidentTimelineFact[]>;
}

export interface AnalyticsSources {
  company(tenantId: string): Promise<CompanyParameters>;
  /** The area and all its descendants; null when the area is not one of the tenant's. */
  areaSubtree(tenantId: string, areaId: string): Promise<readonly string[] | null>;
  readonly fleet: FleetSource;
  readonly documents: DocumentSource;
  readonly insurance: InsuranceSource;
  readonly maintenance: MaintenanceSource;
  readonly incidents: IncidentSource;
}
