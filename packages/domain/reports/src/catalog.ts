import { ReportCatalog } from './engine.js';
import { AREAS, DISPATCHERS, DRIVERS, PEOPLE_COMPLIANCE } from './definitions/workforce.js';
import {
  FLEET_STATUS,
  INSURANCE,
  VEHICLE_DOCUMENTS,
  VEHICLE_INVENTORY,
} from './definitions/vehicles.js';

/**
 * Reports of the catalog (BRD §13.1) this package provides. Each is its own definition with its
 * columns, filters and permissions; PR 2 of MVP-REPORTS adds the maintenance, incident and
 * cross-cutting families next to these.
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
] as const;

export const createReportCatalog = (): ReportCatalog => new ReportCatalog(REPORT_DEFINITIONS);
