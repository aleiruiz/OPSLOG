import { analisisRoutes } from './routes/analisis';
import { configuracionRoutes } from './routes/configuracion';
import { flotaRoutes } from './routes/flota';
import { operacionRoutes } from './routes/operacion';
import { plantillaRoutes } from './routes/plantilla';
import { shellRoutes } from './routes/shell';
import type { RouteAccess, RouteDefinition } from './routes/types';
import type { Permission } from './types';

export type { NavGroup, RouteAccess, RouteDefinition } from './routes/types';

/** Order matters: fixed addresses are listed before `:id` patterns inside each group; groups never overlap. */
export const routes: readonly RouteDefinition[] = [
  ...shellRoutes,
  ...plantillaRoutes,
  ...flotaRoutes,
  ...operacionRoutes,
  ...analisisRoutes,
  ...configuracionRoutes,
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
  if (typeof access !== 'object') return true;
  return 'anyOf' in access ? access.anyOf.some(can) : can(access.permission);
}

export const loginPath = '/iniciar-sesion';

/** Only same-app absolute paths are accepted as a post-login destination (no open redirect). */
export function safeNextPath(candidate: string | null): string {
  if (!candidate || !candidate.startsWith('/') || candidate.startsWith('//')) return '/';
  if (/[\u0000-\u001f\u007f]/.test(candidate)) return '/';
  if (candidate.includes('\\') || candidate.startsWith(loginPath)) return '/';
  return candidate;
}
