import type { RouteDefinition } from './types';

/** Nav group "Operación": incidents. */
export const operacionRoutes: readonly RouteDefinition[] = [
  // Incidents (INC-UI, nav group "Operación"): they follow their own permissions (ADR-0014). The generic
  // `view`, `create` and `edit` grant nothing here; creating needs `incidents:create` or `incidents:report`.
  {
    id: 'incidents',
    pattern: '/incidents',
    title: 'Siniestros',
    access: { permission: 'incidents:view' },
    nav: { group: 'Operación', label: 'Siniestros' },
  },
  {
    id: 'incidentNew',
    pattern: '/incidents/new',
    title: 'Nuevo siniestro',
    access: { anyOf: ['incidents:create', 'incidents:report'] },
  },
  // Fixed addresses before `:id`: the notices of the caller and the company's incident settings.
  {
    id: 'incidentAlerts',
    pattern: '/incidents/avisos',
    title: 'Avisos de siniestros',
    access: { permission: 'incidents:view' },
  },
  {
    id: 'incidentSettings',
    pattern: '/incidents/configuracion',
    title: 'Configuración de siniestros',
    access: { permission: 'manage_config' },
    nav: { group: 'Configuración', label: 'Ajustes de siniestros', requires: 'manage_config' },
  },
  {
    id: 'incidentDetail',
    pattern: '/incidents/:id',
    title: 'Siniestro',
    access: { permission: 'incidents:view' },
  },
  {
    id: 'incidentTab',
    pattern: '/incidents/:id/:tab',
    title: 'Siniestro',
    access: { permission: 'incidents:view' },
  },
];
