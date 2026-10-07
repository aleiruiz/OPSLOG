import type { Permission } from './types';

export type RouteAccess = 'public' | 'authenticated' | { readonly permission: Permission };

export type NavGroup = 'Inicio' | 'Plantilla' | 'Flota' | 'Configuración';

export interface RouteDefinition {
  readonly id:
    | 'home'
    | 'login'
    | 'invitation'
    | 'company'
    | 'users'
    | 'roles'
    | 'vehicles'
    | 'vehicleNew'
    | 'vehicleDetail'
    | 'vehicleEdit'
    | 'assignments'
    | 'assignmentNew'
    | 'assignmentDetail'
    | 'assignmentEnd'
    | 'imports'
    | 'importNew'
    | 'importDetail'
    | 'areas'
    | 'areaNew'
    | 'areaDetail'
    | 'areaEdit'
    | 'areaMove'
    | 'documents'
    | 'documentNew'
    | 'documentDetail'
    | 'documentEdit'
    | 'documentRenew'
    | 'policies'
    | 'policyNew'
    | 'policyDetail'
    | 'policyEdit'
    | 'policyRenew'
    | 'employees'
    | 'employeeNew'
    | 'employeeDetail'
    | 'employeeEdit'
    | 'alerts'
    | 'alertSettings';
  readonly pattern: string;
  readonly title: string;
  readonly access: RouteAccess;
  /** `requires`: an extra permission for the navigation entry only (the route itself follows `access`). */
  readonly nav?: {
    readonly group: NavGroup;
    readonly label: string;
    readonly requires?: Permission;
  };
}

export const routes: readonly RouteDefinition[] = [
  {
    id: 'home',
    pattern: '/',
    title: 'Inicio',
    access: 'authenticated',
    nav: { group: 'Inicio', label: 'Inicio' },
  },
  { id: 'login', pattern: '/iniciar-sesion', title: 'Iniciar sesión', access: 'public' },
  {
    id: 'invitation',
    pattern: '/invitacion/:token',
    title: 'Aceptar invitación',
    access: 'public',
  },
  {
    id: 'invitation',
    pattern: '/invitacion',
    title: 'Aceptar invitación',
    access: 'public',
  },
  // Employees (FLT-PEOPLE, nav group "Plantilla"): read = `view`, create = `create`, change = `edit`; archiving
  // (`delete`) and the status change are actions of the detail. Personal data needs `view_pii` inside the screens.
  {
    id: 'employees',
    pattern: '/plantilla/empleados',
    title: 'Empleados',
    access: { permission: 'view' },
    nav: { group: 'Plantilla', label: 'Empleados' },
  },
  {
    id: 'employeeNew',
    pattern: '/plantilla/empleados/nuevo',
    title: 'Nuevo empleado',
    access: { permission: 'create' },
  },
  {
    id: 'employeeDetail',
    pattern: '/plantilla/empleados/:id',
    title: 'Empleado',
    access: { permission: 'view' },
  },
  {
    id: 'employeeEdit',
    pattern: '/plantilla/empleados/:id/editar',
    title: 'Editar empleado',
    access: { permission: 'edit' },
  },
  // Areas (BRD S06, nav group "Plantilla"): read = `view`, create = `create`, edit/move/activate = `edit`; deactivating
  // (`delete`) is an action of the detail.
  {
    id: 'areas',
    pattern: '/plantilla/areas',
    title: 'Áreas',
    access: { permission: 'view' },
    nav: { group: 'Plantilla', label: 'Áreas' },
  },
  {
    id: 'areaNew',
    pattern: '/plantilla/areas/nueva',
    title: 'Nueva área',
    access: { permission: 'create' },
  },
  {
    id: 'areaDetail',
    pattern: '/plantilla/areas/:id',
    title: 'Área',
    access: { permission: 'view' },
  },
  {
    id: 'areaEdit',
    pattern: '/plantilla/areas/:id/editar',
    title: 'Editar área',
    access: { permission: 'edit' },
  },
  {
    id: 'areaMove',
    pattern: '/plantilla/areas/:id/mover',
    title: 'Mover área',
    access: { permission: 'edit' },
  },
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

export type RouteParams = Readonly<Record<string, string>>;

export function matchPattern(pattern: string, path: string): RouteParams | null {
  const expected = pattern.split('/').filter(Boolean);
  const actual = path.split('/').filter(Boolean);
  if (expected.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (const [index, segment] of expected.entries()) {
    const value = actual[index] as string;
    if (segment.startsWith(':')) {
      try {
        params[segment.slice(1)] = decodeURIComponent(value);
      } catch {
        return null;
      }
    } else if (segment !== value) return null;
  }
  return params;
}

export function resolveRoute(
  path: string,
): { readonly route: RouteDefinition; readonly params: RouteParams } | null {
  for (const route of routes) {
    const params = matchPattern(route.pattern, path);
    if (params) return { route, params };
  }
  return null;
}

export function isAllowed(access: RouteAccess, can: (permission: Permission) => boolean): boolean {
  return typeof access === 'object' ? can(access.permission) : true;
}

export const loginPath = '/iniciar-sesion';

/** Only same-app absolute paths are accepted as a post-login destination (no open redirect). */
export function safeNextPath(candidate: string | null): string {
  if (!candidate || !candidate.startsWith('/') || candidate.startsWith('//')) return '/';
  if (/[\u0000-\u001f\u007f]/.test(candidate)) return '/';
  if (candidate.includes('\\') || candidate.startsWith(loginPath)) return '/';
  return candidate;
}
