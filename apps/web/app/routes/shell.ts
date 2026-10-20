import type { RouteDefinition } from './types';

/** Entry, login and invitation routes. */
export const shellRoutes: readonly RouteDefinition[] = [
  // Global search results (FR-160); the box in the top bar is shown to every signed-in user.
  { id: 'search', pattern: '/buscar', title: 'Buscar', access: 'authenticated' },
  {
    id: 'home',
    pattern: '/',
    title: 'Inicio',
    access: 'authenticated',
    nav: { group: 'Inicio', label: 'Inicio' },
  },
  { id: 'login', pattern: '/iniciar-sesion', title: 'Iniciar sesión', access: 'public' },
  // Return address of a redirecting identity provider (registered there as the callback URL).
  { id: 'authCallback', pattern: '/auth/callback', title: 'Verificando acceso', access: 'public' },
  {
    id: 'invitation',
    pattern: '/invitacion/:token',
    title: 'Aceptar invitación',
    access: 'public',
  },
  { id: 'invitation', pattern: '/invitacion', title: 'Aceptar invitación', access: 'public' },
];
