import { fakeOidcCode } from '../api/fakeOidc';
import type { Permission, RoleSummary } from './types';

/** Synthetic accounts of the fake identity provider (what the person types as "Cuenta de prueba"). */
export const demoSubjects = {
  admin: 'cuenta-admin',
  viewer: 'cuenta-consulta',
  /** Can view, create and edit, but not archive or see personal data (role "Despachador"). */
  dispatch: 'cuenta-despacho',
  /** Can view and create, and see personal data, but not edit (role "Responsable de datos personales"). */
  piiReader: 'cuenta-datos',
  /** Can view and edit, but not create or archive (role "Mecánico"). */
  mechanic: 'cuenta-mecanico',
} as const;

/** What the fake provider hands the browser for each demo account. */
export const demoCredentials = {
  admin: { code: fakeOidcCode(demoSubjects.admin), nonce: 'nonce-demo-admin' },
  viewer: { code: fakeOidcCode(demoSubjects.viewer), nonce: 'nonce-demo-viewer' },
  dispatch: { code: fakeOidcCode(demoSubjects.dispatch), nonce: 'nonce-demo-dispatch' },
  piiReader: { code: fakeOidcCode(demoSubjects.piiReader), nonce: 'nonce-demo-pii' },
  mechanic: { code: fakeOidcCode(demoSubjects.mechanic), nonce: 'nonce-demo-mechanic' },
} as const;

export const demoInvitations = {
  valid: 'invitacion-vigente',
  expired: 'invitacion-vencida',
} as const;

export const allPermissions: readonly Permission[] = [
  'manage_users',
  'manage_config',
  'view',
  'create',
  'edit',
  'delete',
  'export',
  'view_pii',
  'view_costs',
  'view_audit',
  'approve',
  'reopen',
  'incidents:report',
];

export const systemRoles: RoleSummary[] = [
  {
    id: 'role-admin',
    name: 'Administrador de empresa',
    kind: 'system',
    permissions: allPermissions,
    memberCount: 1,
  },
  {
    id: 'role-fleet',
    name: 'Responsable de flotilla',
    kind: 'system',
    permissions: ['view', 'create', 'edit', 'export', 'view_costs', 'approve'],
    memberCount: 2,
  },
  {
    id: 'role-dispatch',
    name: 'Despachador',
    kind: 'system',
    permissions: ['view', 'create', 'edit', 'incidents:report'],
    memberCount: 3,
  },
  {
    id: 'role-claims',
    name: 'Responsable de siniestros',
    kind: 'system',
    permissions: ['view', 'create', 'edit', 'approve', 'reopen', 'view_costs'],
    memberCount: 1,
  },
  {
    id: 'role-mechanic',
    name: 'Mecánico',
    kind: 'system',
    permissions: ['view', 'edit'],
    memberCount: 4,
  },
  {
    id: 'role-supervisor',
    name: 'Supervisor o gerente',
    kind: 'system',
    permissions: ['view', 'export', 'view_costs', 'view_audit', 'approve'],
    memberCount: 1,
  },
  {
    // Mirrors the backend's `pii_reader` template: it can read and create, and is the one that sees personal data.
    id: 'role-pii',
    name: 'Responsable de datos personales',
    kind: 'system',
    permissions: ['view', 'create', 'view_pii'],
    memberCount: 1,
  },
  {
    id: 'role-viewer',
    name: 'Consulta',
    kind: 'system',
    permissions: ['view'],
    memberCount: 1,
  },
];

export const people = [
  { id: 'user-admin', subject: demoSubjects.admin, role: 'role-admin' },
  { id: 'user-viewer', subject: demoSubjects.viewer, role: 'role-viewer' },
  { id: 'user-dispatch', subject: demoSubjects.dispatch, role: 'role-dispatch' },
  { id: 'user-mechanic', subject: demoSubjects.mechanic, role: 'role-mechanic' },
  { id: 'user-pii', subject: demoSubjects.piiReader, role: 'role-pii' },
] as const;
