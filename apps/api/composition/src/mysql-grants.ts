/** Per-table privileges of each module's restricted runtime account (never DDL, DELETE only where the module deletes rows). */
import { AREA_TABLES } from '../../../../packages/persistence/areas/src/index.js';
import { VEHICLE_TABLES } from '../../../../packages/persistence/vehicles/src/index.js';
import { EMPLOYEE_TABLES } from '../../../../packages/persistence/employees/src/index.js';
import { DOCUMENT_TABLES } from '../../../../packages/persistence/documents/src/index.js';
import { POLICY_TABLES } from '../../../../packages/persistence/insurance/src/index.js';
import { ASSIGNMENT_TABLES } from '../../../../packages/persistence/assignments/src/index.js';
import { SETTINGS_TABLES } from '../../../../packages/persistence/settings/src/index.js';
import { IMPORT_TABLES } from '../../../../packages/persistence/imports/src/index.js';
import { FILE_TABLES } from '../../../../packages/persistence/files/src/index.js';
import { MAINTENANCE_TABLES } from '../../../../packages/persistence/maintenance/plans/src/index.js';
import { WORK_ORDER_TABLES } from '../../../../packages/persistence/maintenance/orders/src/index.js';
import { INCIDENT_TABLES } from '../../../../packages/persistence/incidents/cases/src/index.js';
import { INCIDENT_REPAIR_TABLES } from '../../../../packages/persistence/incidents/repairs/src/index.js';
import { INCIDENT_COST_TABLES } from '../../../../packages/persistence/incidents/costs/src/index.js';
import { INCIDENT_SLA_TABLES } from '../../../../packages/persistence/incidents/sla/src/index.js';
import { INCIDENT_WORKFLOW_TABLES } from '../../../../packages/persistence/incidents/workflow/src/index.js';
import { INCIDENT_CHILD_TABLES } from '../../../../packages/persistence/incidents/third-parties/src/index.js';

export type TableGrant = { readonly table: string; readonly privileges: readonly string[] };
export const FLEET_TABLE_GRANTS = {
  areas: [
    { table: AREA_TABLES.areas, privileges: ['SELECT', 'INSERT', 'UPDATE'] },
    { table: AREA_TABLES.responsibles, privileges: ['SELECT', 'INSERT', 'DELETE'] },
    { table: AREA_TABLES.history, privileges: ['SELECT', 'INSERT'] },
    { table: AREA_TABLES.locks, privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
  ],
  vehicles: [
    { table: VEHICLE_TABLES.vehicles, privileges: ['SELECT', 'INSERT', 'UPDATE'] },
    { table: VEHICLE_TABLES.statusHistory, privileges: ['SELECT', 'INSERT'] },
  ],
  employees: [
    { table: EMPLOYEE_TABLES.employees, privileges: ['SELECT', 'INSERT', 'UPDATE'] },
    { table: EMPLOYEE_TABLES.history, privileges: ['SELECT', 'INSERT'] },
  ],
  documents: [
    { table: DOCUMENT_TABLES.documents, privileges: ['SELECT', 'INSERT', 'UPDATE'] },
    { table: DOCUMENT_TABLES.revisions, privileges: ['SELECT', 'INSERT'] },
  ],
  insurance: [
    { table: POLICY_TABLES.policies, privileges: ['SELECT', 'INSERT', 'UPDATE'] },
    { table: POLICY_TABLES.revisions, privileges: ['SELECT', 'INSERT'] },
  ],
  assignments: [
    { table: ASSIGNMENT_TABLES.assignments, privileges: ['SELECT', 'INSERT', 'UPDATE'] },
    { table: ASSIGNMENT_TABLES.events, privileges: ['SELECT', 'INSERT'] },
  ],
  settings: [{ table: SETTINGS_TABLES.settings, privileges: ['SELECT', 'INSERT', 'UPDATE'] }],
  imports: [
    { table: IMPORT_TABLES.jobs, privileges: ['SELECT', 'INSERT', 'UPDATE'] },
    { table: IMPORT_TABLES.rows, privileges: ['SELECT', 'INSERT'] },
    { table: IMPORT_TABLES.events, privileges: ['SELECT', 'INSERT'] },
  ],
  files: [
    { table: FILE_TABLES.records, privileges: ['SELECT', 'INSERT', 'UPDATE'] },
    { table: FILE_TABLES.history, privileges: ['SELECT', 'INSERT'] },
    { table: FILE_TABLES.saga, privileges: ['SELECT', 'INSERT', 'UPDATE'] },
  ],
  maintenance: [
    { table: MAINTENANCE_TABLES.plans, privileges: ['SELECT', 'INSERT', 'UPDATE'] },
    { table: MAINTENANCE_TABLES.versions, privileges: ['SELECT', 'INSERT'] },
    { table: MAINTENANCE_TABLES.occurrences, privileges: ['SELECT', 'INSERT', 'UPDATE'] },
    { table: MAINTENANCE_TABLES.orders, privileges: ['SELECT', 'INSERT', 'UPDATE'] },
    { table: MAINTENANCE_TABLES.alerts, privileges: ['SELECT', 'INSERT'] },
    { table: MAINTENANCE_TABLES.workshops, privileges: ['SELECT', 'INSERT', 'UPDATE'] },
    { table: MAINTENANCE_TABLES.mechanics, privileges: ['SELECT', 'INSERT', 'UPDATE'] },
    { table: WORK_ORDER_TABLES.orders, privileges: ['SELECT', 'INSERT', 'UPDATE'] },
    { table: WORK_ORDER_TABLES.tasks, privileges: ['SELECT', 'INSERT', 'DELETE'] },
    { table: WORK_ORDER_TABLES.parts, privileges: ['SELECT', 'INSERT', 'DELETE'] },
    { table: WORK_ORDER_TABLES.costs, privileges: ['SELECT', 'INSERT', 'DELETE'] },
    { table: WORK_ORDER_TABLES.transitions, privileges: ['SELECT', 'INSERT'] },
    { table: WORK_ORDER_TABLES.files, privileges: ['SELECT', 'INSERT', 'DELETE'] },
    { table: WORK_ORDER_TABLES.idempotency, privileges: ['SELECT', 'INSERT', 'DELETE'] },
  ],
  incidents: [
    { table: INCIDENT_TABLES.incidents, privileges: ['SELECT', 'INSERT', 'UPDATE'] },
    { table: INCIDENT_TABLES.folios, privileges: ['SELECT', 'INSERT', 'UPDATE'] },
    { table: INCIDENT_TABLES.transitions, privileges: ['SELECT', 'INSERT'] },
    { table: INCIDENT_TABLES.idempotency, privileges: ['SELECT', 'INSERT', 'DELETE'] },
    { table: INCIDENT_CHILD_TABLES.thirdParties, privileges: ['SELECT', 'INSERT', 'UPDATE'] },
    { table: INCIDENT_CHILD_TABLES.evidence, privileges: ['SELECT', 'INSERT', 'DELETE'] },
    { table: INCIDENT_WORKFLOW_TABLES.closures, privileges: ['SELECT', 'INSERT'] },
    { table: INCIDENT_REPAIR_TABLES.links, privileges: ['SELECT', 'INSERT', 'DELETE'] },
    { table: INCIDENT_COST_TABLES.lines, privileges: ['SELECT', 'INSERT', 'DELETE'] },
    { table: INCIDENT_COST_TABLES.estimates, privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
    { table: INCIDENT_COST_TABLES.snapshots, privileges: ['SELECT', 'INSERT'] },
    { table: INCIDENT_COST_TABLES.approvals, privileges: ['SELECT', 'INSERT', 'DELETE'] },
    { table: INCIDENT_SLA_TABLES.cycles, privileges: ['SELECT', 'INSERT', 'UPDATE'] },
    { table: INCIDENT_SLA_TABLES.alerts, privileges: ['SELECT', 'INSERT'] },
    { table: INCIDENT_SLA_TABLES.deliveries, privileges: ['SELECT', 'INSERT', 'UPDATE'] },
  ],
} satisfies Record<string, readonly TableGrant[]>;

export type FleetModuleName = keyof typeof FLEET_TABLE_GRANTS;
export const FLEET_MODULES: readonly FleetModuleName[] = [
  'areas',
  'vehicles',
  'employees',
  'documents',
  'insurance',
  'assignments',
  'settings',
  'imports',
  'files',
  'maintenance',
  'incidents',
];
