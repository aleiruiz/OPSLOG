import type { Permission } from '../../../../packages/domain/identity/src/index.js';

/** What a handler needs to know of an incident: ids and the folio, never text of the case. */
export interface IncidentFacts {
  readonly folio: string;
  readonly responsibleId: string | null;
  readonly createdBy: string | null;
}
export interface OrderFacts {
  readonly vehicleId: string;
  readonly status: string;
  /** Identity subject of the assigned mechanic, when the mechanic is a member. */
  readonly mechanicMemberId: string | null;
}
export interface SlaNoticeFacts {
  readonly incidentId: string;
  readonly folio: string;
  /** Fixed text of the notice kind. */
  readonly label: string;
  readonly severity: 'important' | 'critical' | 'attention';
  /** Identity subjects, not `user-` ids. */
  readonly recipients: readonly string[];
}
export interface ExpiryItem {
  readonly source: 'vehicle_document' | 'insurance_policy' | 'employee_license';
  readonly subjectId: string;
  readonly vehicleId: string | null;
  readonly dueOn: string;
  readonly daysToExpiry: number;
}

/**
 * Where the handlers read the facts of an event. The composition implements it over the modules'
 * own ports; every method names the company and answers null (or nothing) for a record it cannot see.
 */
export interface NotificationSources {
  incident(tenantId: string, incidentId: string): Promise<IncidentFacts | null>;
  order(tenantId: string, orderId: string): Promise<OrderFacts | null>;
  /** The vehicle of a maintenance plan. */
  planVehicle(tenantId: string, planId: string): Promise<string | null>;
  /** Economic number of a vehicle. */
  vehicleLabel(tenantId: string, vehicleId: string): Promise<string | null>;
  /** The person who asked for an export and the title of its report (a catalog text). */
  exportJob(
    tenantId: string,
    jobId: string,
  ): Promise<{ readonly requesterId: string; readonly reportTitle: string } | null>;
  /** Active members who hold the permission now (identity subjects). */
  holders(tenantId: string, permission: Permission): Promise<readonly string[]>;
  slaNotice(tenantId: string, alertId: string): Promise<SlaNoticeFacts | null>;
  /** Everything that is due or recently expired, soonest first. */
  expiring(tenantId: string): Promise<readonly ExpiryItem[]>;
  timeZone(tenantId: string): Promise<string>;
}
