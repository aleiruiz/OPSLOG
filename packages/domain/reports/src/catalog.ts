import { ReportCatalog } from './engine.js';
import { AREAS, DISPATCHERS, DRIVERS, PEOPLE_COMPLIANCE } from './definitions/workforce.js';
import {
  MAINTENANCE_COSTS,
  MAINTENANCE_CORRECTIVE,
  MAINTENANCE_FREQUENCY,
} from './definitions/maintenance.js';
import { MAINTENANCE_PLAN_VS_ACTUAL } from './definitions/maintenance-plan.js';
import {
  INCIDENTS_BY_PERIOD,
  INCIDENTS_BY_SUBJECT,
  INCIDENTS_DISTRIBUTION,
} from './definitions/incidents.js';
import { INCIDENT_AGING, INCIDENT_COSTS, INCIDENT_RESOLUTION } from './definitions/incident-ops.js';
import { AUDIT_LOG, EXPIRATIONS } from './definitions/transversal.js';
import { VEHICLE_HISTORY } from './definitions/history.js';
import { VEHICLE_SHEET } from './definitions/sheets.js';
import { DRIVER_SHEET, INCIDENT_SHEET } from './definitions/sheets-people.js';
import {
  FLEET_STATUS,
  INSURANCE,
  VEHICLE_DOCUMENTS,
  VEHICLE_INVENTORY,
} from './definitions/vehicles.js';

/**
 * Reports of the catalog (BRD §13.1) and the record sheets of FR-147. Each is its own definition
 * with its columns, filters and permissions.
 */
export const REPORT_DEFINITIONS = [
  DRIVERS,
  DISPATCHERS,
  AREAS,
  PEOPLE_COMPLIANCE,
  VEHICLE_INVENTORY,
  FLEET_STATUS,
  INSURANCE,
  VEHICLE_DOCUMENTS,
  VEHICLE_HISTORY,
  MAINTENANCE_PLAN_VS_ACTUAL,
  MAINTENANCE_CORRECTIVE,
  MAINTENANCE_COSTS,
  MAINTENANCE_FREQUENCY,
  INCIDENTS_BY_PERIOD,
  INCIDENTS_BY_SUBJECT,
  INCIDENTS_DISTRIBUTION,
  INCIDENT_COSTS,
  INCIDENT_RESOLUTION,
  INCIDENT_AGING,
  EXPIRATIONS,
  AUDIT_LOG,
  VEHICLE_SHEET,
  DRIVER_SHEET,
  INCIDENT_SHEET,
] as const;

export const createReportCatalog = (): ReportCatalog => new ReportCatalog(REPORT_DEFINITIONS);
