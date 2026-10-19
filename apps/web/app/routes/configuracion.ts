import type { RouteDefinition } from './types';

/** Nav group "Configuración". */
export const configuracionRoutes: readonly RouteDefinition[] = [
  {
    id: 'alertSettings',
    pattern: '/configuracion/alertas',
    title: 'Ajustes de alertas',
    access: { permission: 'view' },
    nav: { group: 'Configuración', label: 'Ajustes de alertas', requires: 'manage_config' },
  },
  {
    id: 'company',
    pattern: '/configuracion/empresa',
    title: 'Empresa',
    access: { permission: 'manage_config' },
    nav: { group: 'Configuración', label: 'Empresa' },
  },
  {
    id: 'users',
    pattern: '/configuracion/usuarios',
    title: 'Usuarios',
    access: { permission: 'manage_users' },
    nav: { group: 'Configuración', label: 'Usuarios' },
  },
  {
    id: 'roles',
    pattern: '/configuracion/roles',
    title: 'Roles',
    access: { permission: 'manage_users' },
    nav: { group: 'Configuración', label: 'Roles' },
  },
];
