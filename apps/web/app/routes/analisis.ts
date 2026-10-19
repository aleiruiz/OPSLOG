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
];
