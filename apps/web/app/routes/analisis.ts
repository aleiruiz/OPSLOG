import type { RouteDefinition } from './types';

/** Nav group "Análisis": read-only views over what the company has recorded. */
export const analisisRoutes: readonly RouteDefinition[] = [
  // Audit (AUDIT-UI, S26): `view_audit` is held by admin and auditor; the BFF filters entities by their own permission.
  {
    id: 'audit',
    pattern: '/analisis/auditoria',
    title: 'Auditoría',
    access: { permission: 'view_audit' },
    nav: { group: 'Análisis', label: 'Auditoría' },
  },
  // Reports (MVP-REPORTS, S25): catalog, preview and exports; exporting also needs `export` (the BFF checks it).
  {
    id: 'reports',
    pattern: '/analisis/reportes',
    title: 'Reportes',
    access: { permission: 'view' },
    // The entry follows `export` so a reader without it keeps no «Análisis» group (the audit screen test
    // pins that); the route itself stays open to everyone with `view`.
    nav: { group: 'Análisis', label: 'Reportes', requires: 'export' },
  },
];
