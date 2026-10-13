import type { Permission } from './types';

/** User-facing labels. Technical permission ids are never shown as primary text (SPECS §8). */
export const permissionLabels: Record<Permission, string> = {
  manage_users: 'Administrar usuarios y roles',
  manage_config: 'Administrar la configuración de la empresa',
  view: 'Consultar información',
  create: 'Crear registros',
  edit: 'Editar registros',
  delete: 'Eliminar registros',
  export: 'Exportar datos',
  view_pii: 'Ver datos personales',
  view_costs: 'Ver costos',
  view_audit: 'Ver la auditoría',
  approve: 'Aprobar solicitudes',
  reopen: 'Reabrir registros cerrados',
  'incidents:view': 'Consultar siniestros',
  'incidents:create': 'Crear borradores de siniestros',
  'incidents:edit': 'Editar y gestionar siniestros',
  'incidents:report': 'Reportar siniestros',
  'incidents:approve': 'Aprobar cierres costosos y siniestros',
  'incidents:close': 'Cerrar siniestros resueltos',
  'incidents:reopen': 'Reabrir siniestros cerrados',
  'incidents:view_costs': 'Ver costos de siniestros',
};
