/**
 * Entity types that appear in the audit: their Spanish name and the permission that reads the module
 * (null: the entity is only described by its type). The per-entity history also needs that permission.
 */
export interface AuditEntityType {
  readonly label: string;
  readonly read: string | null;
}

const ENTITY_TYPES: Readonly<Record<string, AuditEntityType>> = {
  vehicle: { label: 'Vehículo', read: 'view' },
  vehicle_assignment: { label: 'Asignación', read: 'view' },
  assignment: { label: 'Asignación', read: 'view' },
  employee: { label: 'Empleado', read: 'view' },
  area: { label: 'Área', read: 'view' },
  document: { label: 'Documento', read: 'view' },
  insurance_policy: { label: 'Póliza', read: 'view' },
  import_job: { label: 'Importación', read: 'view' },
  file: { label: 'Archivo', read: 'view' },
  incident: { label: 'Siniestro', read: 'incidents:view' },
  incident_third_party: { label: 'Tercero de siniestro', read: 'incidents:view' },
  maintenance_work_order: { label: 'Orden de trabajo', read: 'view' },
  maintenance_plan: { label: 'Plan de mantenimiento', read: 'view' },
  maintenance_workshop: { label: 'Taller', read: 'view' },
  maintenance_mechanic: { label: 'Mecánico', read: 'view' },
  company_settings: { label: 'Ajustes de la empresa', read: 'manage_config' },
  role: { label: 'Rol', read: 'manage_users' },
};

export const AUDIT_ENTITY_TYPES: readonly string[] = Object.keys(ENTITY_TYPES);

export function entityType(type: string): AuditEntityType | undefined {
  return ENTITY_TYPES[type];
}

export function entityTypeLabel(type: string): string {
  return ENTITY_TYPES[type]?.label ?? 'Registro';
}

/** `fa3c…` style short form of an opaque id, for records that have no readable description. */
export function shortId(id: string): string {
  return id.length <= 8 ? id : `${id.slice(0, 8)}…`;
}
