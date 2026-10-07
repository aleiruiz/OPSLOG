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
];
