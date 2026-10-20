/** Spanish text of every action the product writes to the audit (BRD §16.2), by domain. */
const ACTIONS: Readonly<Record<string, string>> = {
  'vehicle.created': 'Vehículo creado',
  'vehicle.updated': 'Vehículo actualizado',
  'vehicle.archived': 'Vehículo archivado',
  'vehicle.status_changed': 'Estado del vehículo cambiado',
  'vehicle.odometer_recorded': 'Odómetro registrado',
  'vehicle_assignment.created': 'Asignación creada',
  'vehicle_assignment.ended': 'Asignación cerrada',
  'employee.created': 'Empleado creado',
  'employee.updated': 'Empleado actualizado',
  'employee.archived': 'Empleado archivado',
  'employee.status_changed': 'Estado del empleado cambiado',
  'employee.pii_viewed': 'Datos personales consultados',
  'area.created': 'Área creada',
  'area.updated': 'Área actualizada',
  'area.moved': 'Área movida',
  'area.activated': 'Área activada',
  'area.deactivated': 'Área desactivada',
  'document.created': 'Documento creado',
  'document.updated': 'Documento actualizado',
  'document.revised': 'Documento revisado',
  'document.renewed': 'Documento renovado',
  'document.archived': 'Documento archivado',
  'insurance_policy.created': 'Póliza creada',
  'insurance_policy.updated': 'Póliza actualizada',
  'insurance_policy.renewed': 'Póliza renovada',
  'insurance_policy.archived': 'Póliza archivada',
  'import_job.created': 'Importación realizada',
  'company_settings.updated': 'Ajustes de la empresa actualizados',
  'file.upload_requested': 'Subida de archivo solicitada',
  'file.uploaded': 'Archivo subido',
  'file.record_created': 'Registro de archivo creado',
  'file.scan_clean': 'Archivo revisado sin hallazgos',
  'file.scan_rejected': 'Archivo rechazado por la revisión',
  'file.scan_deferred': 'Revisión de archivo pospuesta',
  'file.rejected': 'Archivo rechazado',
  'file.released': 'Archivo liberado',
  'file.derivative_created': 'Derivado de archivo creado',
  'file.derivative_upload_requested': 'Derivado de archivo solicitado',
  'file.upload_abandoned': 'Subida de archivo abandonada',
  'file.grant_issued': 'Permiso de descarga emitido',
  'file.downloaded': 'Archivo descargado',
  'file.access_denied': 'Acceso a archivo denegado',
  'incident.created': 'Siniestro creado',
  'incident.updated': 'Siniestro actualizado',
  'incident.status_changed': 'Estado del siniestro cambiado',
  'incident.assigned': 'Siniestro asignado',
  'incident.closed': 'Siniestro cerrado',
  'incident.reopened': 'Siniestro reabierto',
  'incident.cancelled': 'Siniestro cancelado',
  'incident.coverage_none': 'Siniestro sin cobertura',
  'incident.costs_changed': 'Costos del siniestro modificados',
  'incident.repair_linked': 'Reparación vinculada al siniestro',
  'incident.repair_unlinked': 'Reparación desvinculada del siniestro',
  'incident.evidence_downloaded': 'Evidencia de siniestro descargada',
  'incident.sla_alert': 'Aviso de plazo de siniestro',
  'incident.access_denied': 'Acceso a siniestro denegado',
  'maintenance.work_order.created': 'Orden de trabajo creada',
  'maintenance.work_order.work_recorded': 'Trabajo de la orden registrado',
  'maintenance.work_order.costs_recorded': 'Costos de la orden registrados',
  'maintenance.status_changed': 'Estado de la orden cambiado',
  'maintenance.plan.created': 'Plan de mantenimiento creado',
  'maintenance.plan.updated': 'Plan de mantenimiento actualizado',
  'maintenance.plan.advanced': 'Plan de mantenimiento avanzado',
  'maintenance.plan.reverted': 'Plan de mantenimiento revertido',
  'maintenance.plan.alerted': 'Aviso de plan de mantenimiento',
  'maintenance.workshop.created': 'Taller creado',
  'maintenance.workshop.updated': 'Taller actualizado',
  'maintenance.workshop.deactivated': 'Taller desactivado',
  'maintenance.mechanic.created': 'Mecánico creado',
  'maintenance.mechanic.updated': 'Mecánico actualizado',
  'maintenance.mechanic.deactivated': 'Mecánico desactivado',
  'maintenance.occurrence.cancelled': 'Ocurrencia de plan cancelada',
  'maintenance.occurrence.reopened': 'Ocurrencia de plan reabierta',
  'maintenance.occurrence.restored': 'Ocurrencia de plan restaurada',
  'maintenance.occurrence.superseded': 'Ocurrencia de plan sustituida',
  'maintenance.occurrence.completed_without_advance': 'Ocurrencia de plan cerrada sin avanzar',
  'tenant.bootstrapped': 'Empresa dada de alta',
  'tenant.suspended': 'Empresa suspendida',
  'tenant.reactivated': 'Empresa reactivada',
  'tenant.settings_updated': 'Ajustes de la empresa actualizados',
  'tenant.security_settings_updated': 'Ajustes de seguridad actualizados',
  'user.invited': 'Usuario invitado',
  'user.joined': 'Usuario incorporado',
  'invitation.revoked': 'Invitación revocada',
  'membership.role_changed': 'Rol de un usuario cambiado',
  'membership.revoked': 'Acceso de un usuario retirado',
  'role.copied': 'Rol copiado',
};

/** Domain of each action prefix, for the filter's allowlist and the fallback text. */
const DOMAINS: Readonly<Record<string, string>> = {
  vehicle: 'Vehículos',
  vehicle_assignment: 'Asignaciones',
  employee: 'Empleados',
  area: 'Áreas',
  document: 'Documentos',
  insurance_policy: 'Pólizas',
  import_job: 'Importaciones',
  company_settings: 'Ajustes de la empresa',
  file: 'Archivos',
  incident: 'Siniestros',
  maintenance: 'Mantenimiento',
  tenant: 'Empresa',
  user: 'Usuarios',
  invitation: 'Invitaciones',
  membership: 'Accesos',
  role: 'Roles',
};

export const AUDIT_ACTION_DOMAINS: readonly string[] = Object.keys(DOMAINS);
export const AUDIT_ACTION_CODES: readonly string[] = Object.keys(ACTIONS);

const SHAPE = /^[a-z][a-z0-9_.]{0,63}$/;

/** Readable text of an action; a code outside the catalog reads as its domain, never as a raw technical id. */
export function actionLabel(action: string): string {
  const known = ACTIONS[action];
  if (known) return known;
  const domain = DOMAINS[action.split('.')[0] ?? ''];
  return domain ? `${domain}: otra acción registrada` : 'Acción registrada';
}

/** A prefix is accepted when it narrows one allowlisted domain (`incident`, `incident.`, `vehicle.status`). */
export function isAllowedActionPrefix(prefix: string): boolean {
  if (!SHAPE.test(prefix)) return false;
  const domain = prefix.split('.')[0] as string;
  return AUDIT_ACTION_DOMAINS.includes(domain);
}

/** Domains offered by the filter, with their Spanish names. */
export function actionDomainOptions(): readonly {
  readonly value: string;
  readonly label: string;
}[] {
  return AUDIT_ACTION_DOMAINS.map((value) => ({
    value: `${value}.`,
    label: DOMAINS[value] as string,
  }));
}

/** Denied attempts are audited as `<domain>.access_denied`; everything else is a performed action. */
export const isDeniedAction = (action: string): boolean => action.endsWith('.access_denied');
