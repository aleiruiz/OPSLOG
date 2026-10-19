/**
 * What the company export takes from the database (NFR-B5, SPECS §9.3). Every table of the company
 * database is either exported or excluded with a reason: a table nobody classified stops the export
 * (`unclassified_table`), so a new migration cannot silently fall out of the archive. The test of this
 * package keeps the catalog in step with the migrated schema.
 */

/** Why a table is not in the archive. Nothing excluded is business data of the company. */
export type ExclusionReason =
  | 'schema_metadata'
  | 'lock'
  | 'session_or_token'
  | 'audit_plumbing'
  | 'internal_queue'
  | 'idempotency_cache'
  | 'derived_index';

/** A sealed column (`pii1.` envelope) that the archive carries in clear, under the name `as`. */
export interface SealedColumn {
  readonly column: string;
  readonly as: string;
  readonly entityType: string;
  /** Field label of the encryption context (the same one the owning module seals with). */
  readonly field: string;
  /** Columns joined with `:` that form the entity id of the encryption context. */
  readonly entityId: readonly string[];
}

/** How rows of a table are limited to the company. */
export type RowScope = 'company' | 'identity_of_company' | 'tenant_record';

export interface ExportedTable {
  readonly kind: 'export';
  readonly scope: RowScope;
  readonly sealed?: readonly SealedColumn[];
  /**
   * Columns that never leave the database: keyed hashes of personal data (blind indexes, which are
   * derived and useless outside the installation) and the sealed secrets of webhook endpoints (a
   * credential, not data of the company).
   */
  readonly omit?: readonly string[];
}

export interface ExcludedTable {
  readonly kind: 'exclude';
  readonly reason: ExclusionReason;
}

export type TableDisposition = ExportedTable | ExcludedTable;

const company: ExportedTable = { kind: 'export', scope: 'company' };
const exclude = (reason: ExclusionReason): ExcludedTable => ({ kind: 'exclude', reason });

const employeeField = (column: string, field: string): SealedColumn => ({
  column: `${column}_enc`,
  as: column,
  entityType: 'employee',
  field,
  entityId: ['id'],
});

const thirdPartyField = (column: string, field: string): SealedColumn => ({
  column: `${column}_enc`,
  as: column,
  entityType: 'incident_third_party',
  field,
  entityId: ['incident_id', 'id'],
});

/** Tables of the company database by name. Names of migration journals are matched by suffix. */
export const CATALOG: Readonly<Record<string, TableDisposition>> = {
  // Company record, users and roles.
  opslog_control_tenants: { kind: 'export', scope: 'tenant_record' },
  opslog_control_tenant_settings: company,
  opslog_control_memberships: company,
  opslog_identity_memberships: company,
  opslog_identity_roles: company,
  opslog_identity_role_permissions: company,
  opslog_identity_identities: { kind: 'export', scope: 'identity_of_company' },
  opslog_identity_external_identities: { kind: 'export', scope: 'identity_of_company' },
  opslog_company_settings: company,
  // Areas, vehicles, people, assignments.
  opslog_areas: company,
  opslog_area_history: company,
  opslog_area_responsibles: company,
  opslog_vehicles: company,
  opslog_vehicle_status_history: company,
  opslog_vehicle_assignments: company,
  opslog_vehicle_assignment_events: company,
  opslog_employees: {
    kind: 'export',
    scope: 'company',
    sealed: [
      employeeField('national_id', 'national_id'),
      employeeField('phone', 'phone'),
      employeeField('email', 'email'),
      employeeField('license_number', 'license_number'),
    ],
    omit: ['national_id_idx', 'email_idx', 'license_number_idx'],
  },
  opslog_employee_history: company,
  // Documents, insurance, files.
  opslog_documents: company,
  opslog_document_revisions: company,
  opslog_insurance_policies: company,
  opslog_insurance_policy_revisions: company,
  opslog_files: { kind: 'export', scope: 'company' },
  opslog_file_history: { kind: 'export', scope: 'company' },
  // Maintenance.
  opslog_maintenance_workshops: company,
  opslog_maintenance_mechanics: company,
  opslog_maintenance_plans: company,
  opslog_maintenance_plan_versions: company,
  opslog_maintenance_plan_occurrences: company,
  opslog_maintenance_plan_alerts: company,
  opslog_maintenance_scheduled_orders: company,
  opslog_maintenance_work_orders: company,
  opslog_maintenance_work_order_tasks: company,
  opslog_maintenance_work_order_parts: company,
  opslog_maintenance_work_order_costs: company,
  opslog_maintenance_work_order_files: company,
  opslog_maintenance_work_order_transitions: company,
  // Incidents.
  opslog_incident_incidents: company,
  opslog_incident_transitions: company,
  opslog_incident_evidence: company,
  opslog_incident_closures: company,
  opslog_incident_repair_links: company,
  opslog_incident_cost_estimates: company,
  opslog_incident_cost_lines: company,
  opslog_incident_cost_approvals: company,
  opslog_incident_cost_snapshots: company,
  opslog_incident_sla_cycles: company,
  opslog_incident_sla_alerts: company,
  opslog_incident_alert_deliveries: company,
  opslog_incident_folio_sequences: company,
  opslog_incident_third_parties: {
    kind: 'export',
    scope: 'company',
    sealed: [
      thirdPartyField('name', 'name'),
      thirdPartyField('contact', 'contact'),
      thirdPartyField('plates', 'plates'),
      thirdPartyField('policy_number', 'policy_number'),
    ],
  },
  // Notifications, webhooks, imports, report jobs, audit.
  opslog_notifications: company,
  opslog_notification_deliveries: company,
  opslog_notification_preferences: company,
  opslog_notification_rules: company,
  opslog_notification_subscriptions: company,
  opslog_webhook_endpoints: {
    kind: 'export',
    scope: 'company',
    omit: ['secret_sealed', 'previous_sealed'],
  },
  opslog_webhook_deliveries: company,
  opslog_webhook_driver_state: company,
  opslog_import_jobs: company,
  opslog_import_job_events: company,
  opslog_import_job_rows: company,
  opslog_export_jobs: company,
  opslog_audit_log: { kind: 'export', scope: 'company' },
  // Not exported.
  opslog_area_locks: exclude('lock'),
  opslog_identity_tenant_locks: exclude('lock'),
  opslog_control_sessions: exclude('session_or_token'),
  opslog_identity_sessions: exclude('session_or_token'),
  opslog_identity_invitations: exclude('session_or_token'),
  opslog_identity_recoveries: exclude('session_or_token'),
  opslog_audit_local: exclude('audit_plumbing'),
  opslog_audit_local_keys: exclude('audit_plumbing'),
  opslog_audit_registry: exclude('audit_plumbing'),
  opslog_audit_delivery: exclude('audit_plumbing'),
  opslog_tenant_outbox: exclude('internal_queue'),
  opslog_file_saga: exclude('internal_queue'),
  opslog_incident_idempotency: exclude('idempotency_cache'),
  opslog_maintenance_work_order_idempotency: exclude('idempotency_cache'),
  opslog_search_entries: exclude('derived_index'),
};

const MIGRATIONS_JOURNAL = /_migrations$/;

/** The disposition of a table, or `undefined` when nobody classified it. */
export function dispositionOf(table: string): TableDisposition | undefined {
  if (MIGRATIONS_JOURNAL.test(table)) return exclude('schema_metadata');
  return CATALOG[table];
}

/** The `company_id` / `tenant_id` column that limits rows to the company, if the table has one. */
export function companyColumn(columns: readonly string[]): 'company_id' | 'tenant_id' | undefined {
  if (columns.includes('company_id')) return 'company_id';
  if (columns.includes('tenant_id')) return 'tenant_id';
  return undefined;
}
