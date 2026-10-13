import type { Route } from './routes/shared.js';
import { AUTH_ROUTES } from './routes/auth.js';
import { SETTINGS_ROUTES } from './routes/settings.js';
import { USER_ROUTES } from './routes/users.js';
import { VEHICLE_ROUTES } from './routes/vehicles.js';
import { EMPLOYEE_ROUTES } from './routes/employees.js';
import { DOCUMENT_ROUTES } from './routes/documents.js';
import { INSURANCE_ROUTES } from './routes/insurance.js';
import { ASSIGNMENT_ROUTES } from './routes/assignments.js';
import { IMPORT_ROUTES } from './routes/imports.js';
import { ALERT_ROUTES } from './routes/alerts.js';
import { AREA_ROUTES } from './routes/areas.js';
import { MAINTENANCE_ROUTES } from './routes/maintenance.js';
import { MAINTENANCE_ALERT_ROUTES } from './routes/maintenance-alerts.js';
import { WORK_ORDER_ROUTES } from './routes/work-orders.js';
import { INCIDENT_SLA_ROUTES } from './routes/incident-sla.js';
import { INCIDENT_ROUTES } from './routes/incidents.js';
import { INCIDENT_CHILD_ROUTES } from './routes/incident-children.js';
import { INCIDENT_COST_ROUTES } from './routes/incident-costs.js';
import { INCIDENT_WORKFLOW_ROUTES } from './routes/incident-workflow.js';

export type { Route, RouteContext, RouteKind } from './routes/shared.js';

export const ROUTES: readonly Route[] = [
  ...AUTH_ROUTES,
  ...SETTINGS_ROUTES,
  ...USER_ROUTES,
  ...VEHICLE_ROUTES,
  ...EMPLOYEE_ROUTES,
  ...DOCUMENT_ROUTES,
  ...INSURANCE_ROUTES,
  ...ASSIGNMENT_ROUTES,
  ...IMPORT_ROUTES,
  ...ALERT_ROUTES,
  ...AREA_ROUTES,
  ...MAINTENANCE_ROUTES,
  ...MAINTENANCE_ALERT_ROUTES,
  ...WORK_ORDER_ROUTES,
  // The literal `alerts` segment goes before `incidents/:incidentId`: the first match wins.
  ...INCIDENT_SLA_ROUTES,
  ...INCIDENT_ROUTES,
  ...INCIDENT_CHILD_ROUTES,
  ...INCIDENT_WORKFLOW_ROUTES,
  ...INCIDENT_COST_ROUTES,
];
