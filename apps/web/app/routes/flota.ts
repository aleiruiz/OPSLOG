import type { RouteDefinition } from './types';

/** Nav group "Flota": vehicles, assignments, documents, policies, alerts, maintenance, imports. */
export const flotaRoutes: readonly RouteDefinition[] = [
  // Vehicles: read = `view`, create = `create`, change = `edit`; archiving (`delete`) is an action of the detail.
  {
    id: 'vehicles',
    pattern: '/flota/vehiculos',
    title: 'Vehículos',
    access: { permission: 'view' },
    nav: { group: 'Flota', label: 'Vehículos' },
  },
  {
    id: 'vehicleNew',
    pattern: '/flota/vehiculos/nuevo',
    title: 'Nuevo vehículo',
    access: { permission: 'create' },
  },
  {
    id: 'vehicleDetail',
    pattern: '/flota/vehiculos/:id',
    title: 'Vehículo',
    access: { permission: 'view' },
  },
  {
    id: 'vehicleEdit',
    pattern: '/flota/vehiculos/:id/editar',
    title: 'Editar vehículo',
    access: { permission: 'edit' },
  },
  // Replacing a principal requires create + edit in the screen and on the BFF.
  {
    id: 'assignments',
    pattern: '/flota/asignaciones',
    title: 'Asignaciones',
    access: { permission: 'view' },
    nav: { group: 'Flota', label: 'Asignaciones' },
  },
  {
    id: 'assignmentNew',
    pattern: '/flota/asignaciones/nueva',
    title: 'Nueva asignación',
    access: { permission: 'create' },
  },
  {
    id: 'assignmentDetail',
    pattern: '/flota/asignaciones/:id',
    title: 'Asignación',
    access: { permission: 'view' },
  },
  {
    id: 'assignmentEnd',
    pattern: '/flota/asignaciones/:id/cerrar',
    title: 'Cerrar asignación',
    access: { permission: 'edit' },
  },
  // Documents with an expiry date: read = `view`, create = `create`, edit/renew = `edit`; archiving (`delete`) is an
  // action of the detail. Insurance policies follow the same permissions (the deductible also needs `view_costs`).
  {
    id: 'documents',
    pattern: '/flota/documentos',
    title: 'Documentos',
    access: { permission: 'view' },
    nav: { group: 'Flota', label: 'Documentos' },
  },
  {
    id: 'documentNew',
    pattern: '/flota/documentos/nuevo',
    title: 'Nuevo documento',
    access: { permission: 'create' },
  },
  {
    id: 'documentDetail',
    pattern: '/flota/documentos/:id',
    title: 'Documento',
    access: { permission: 'view' },
  },
  {
    id: 'documentEdit',
    pattern: '/flota/documentos/:id/editar',
    title: 'Editar documento',
    access: { permission: 'edit' },
  },
  {
    id: 'documentRenew',
    pattern: '/flota/documentos/:id/renovar',
    title: 'Renovar documento',
    access: { permission: 'edit' },
  },
  {
    id: 'policies',
    pattern: '/flota/seguros',
    title: 'Seguros',
    access: { permission: 'view' },
    nav: { group: 'Flota', label: 'Seguros' },
  },
  {
    id: 'policyNew',
    pattern: '/flota/seguros/nueva',
    title: 'Nueva póliza',
    access: { permission: 'create' },
  },
  {
    id: 'policyDetail',
    pattern: '/flota/seguros/:id',
    title: 'Póliza',
    access: { permission: 'view' },
  },
  {
    id: 'policyEdit',
    pattern: '/flota/seguros/:id/editar',
    title: 'Editar póliza',
    access: { permission: 'edit' },
  },
  {
    id: 'policyRenew',
    pattern: '/flota/seguros/:id/renovar',
    title: 'Renovar póliza',
    access: { permission: 'edit' },
  },
  // Expiry alerts (FLT-ALERTS): derived and read-only, so `view` is enough. The settings (window and recipients) are
  // read with `view` as well and written with `manage_config`; the screen shows them read-only otherwise, and only
  // people who can change them see the entry in the navigation (the others reach it from the alert list).
  {
    id: 'alerts',
    pattern: '/flota/alertas',
    title: 'Alertas',
    access: { permission: 'view' },
    nav: { group: 'Flota', label: 'Alertas' },
  },
  // Maintenance (MNT-UI, composed by MNT-INTEGRATE): plans, work orders, my orders and the workshop
  // catalog live behind one entry; commands are authorized by the BFF.
  {
    id: 'maintenance',
    pattern: '/flota/mantenimiento',
    title: 'Mantenimiento',
    access: { permission: 'view' },
    nav: { group: 'Flota', label: 'Mantenimiento' },
  },
  // One order of the maintenance area, linkable and closed with the browser's back button.
  {
    id: 'maintenanceOrder',
    pattern: '/flota/mantenimiento/ordenes/:id',
    title: 'Orden de mantenimiento',
    access: { permission: 'view' },
  },
  {
    id: 'imports',
    pattern: '/flota/importaciones',
    title: 'Importaciones',
    access: { permission: 'view' },
    nav: { group: 'Flota', label: 'Importaciones' },
  },
  {
    id: 'importNew',
    pattern: '/flota/importaciones/nueva',
    title: 'Nueva importación',
    access: { permission: 'create' },
  },
  {
    id: 'importDetail',
    pattern: '/flota/importaciones/:id',
    title: 'Importación',
    access: { permission: 'view' },
  },
];
