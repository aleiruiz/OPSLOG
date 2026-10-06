import type { Permission } from './types';

export type RouteAccess = 'public' | 'authenticated' | { readonly permission: Permission };

export type NavGroup = 'Inicio' | 'Configuración';

export interface RouteDefinition {
  readonly id: 'home' | 'login' | 'invitation' | 'company' | 'users' | 'roles';
  readonly pattern: string;
  readonly title: string;
  readonly access: RouteAccess;
  readonly nav?: { readonly group: NavGroup; readonly label: string };
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
  if (candidate.includes('\\') || candidate.startsWith(loginPath)) return '/';
  return candidate;
}
