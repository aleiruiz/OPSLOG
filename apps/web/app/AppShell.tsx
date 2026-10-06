import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import React from 'react';
import { Button, opslogTokens } from '@opslog/ui';
import type { Permission, SessionInfo } from './types';
import { RouterLink, useRouter } from './router';
import { routes, isAllowed, type NavGroup, type RouteDefinition } from './routes';

const { colors, layout } = opslogTokens;

const navGroups: readonly NavGroup[] = ['Inicio', 'Configuración'];

/** Navigation entries the current permissions allow, grouped in the SPECS §8 order. */
export function visibleNavigation(
  can: (permission: Permission) => boolean,
): { group: NavGroup; items: RouteDefinition[] }[] {
  return navGroups
    .map((group) => ({
      group,
      items: routes.filter((route) => route.nav?.group === group && isAllowed(route.access, can)),
    }))
    .filter((entry) => entry.items.length > 0);
}

export function AppShell({
  session,
  currentRouteId,
  can,
  onSignOut,
  locked = false,
  children,
}: {
  session: SessionInfo;
  currentRouteId: string | null;
  can: (permission: Permission) => boolean;
  onSignOut: () => void;
  /** Expired session: navigation and sign-out are inert so no screen (and its drafts) can be left. */
  locked?: boolean;
  children: React.ReactNode;
}) {
  const navigation = visibleNavigation(can);
  const { path } = useRouter();
  const main = React.useRef<HTMLElement>(null);
  const firstRender = React.useRef(true);
  // Moving between screens would otherwise leave keyboard focus on a link that may have disappeared.
  React.useEffect(() => {
    if (firstRender.current) firstRender.current = false;
    else main.current?.focus();
  }, [path]);
  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Box
        component="a"
        href="#contenido"
        className="sr-only"
        sx={{
          '&:focus': {
            position: 'static',
            width: 'auto',
            height: 'auto',
            margin: 0,
            clip: 'auto',
            p: 1,
            bgcolor: 'background.paper',
          },
        }}
      >
        Saltar al contenido
      </Box>
      <Box
        component="header"
        sx={{
          bgcolor: colors.navigation,
          color: 'common.white',
          px: { xs: 2, md: 3 },
          py: 1.5,
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 2,
        }}
      >
        <Typography
          component="p"
          variant="h2"
          sx={{ fontFamily: opslogTokens.typography.monoFamily }}
        >
          OPSLOG
        </Typography>
        <Box role="group" aria-label="Empresa" sx={{ flex: 1, minWidth: 0 }}>
          <Typography component="span" variant="body2">
            Empresa:{' '}
          </Typography>
          <Typography component="strong" variant="body2" data-testid="shell-company">
            {session.company.name}
          </Typography>
        </Box>
        <Box role="group" aria-label="Usuario" sx={{ minWidth: 0 }}>
          <Typography component="span" variant="body2" data-testid="shell-user">
            {session.user.displayName} · {session.roleLabel}
          </Typography>
        </Box>
        <Button
          {...(locked ? { disabled: true } : {})}
          variant="outlined"
          color="inherit"
          size="small"
          onClick={onSignOut}
          sx={{ borderColor: colors.borderStrong }}
        >
          Cerrar sesión
        </Button>
      </Box>
      <Box sx={{ display: 'flex', flex: 1, flexDirection: { xs: 'column', md: 'row' } }}>
        <Box
          component="nav"
          {...(locked ? { inert: true } : {})}
          aria-label="Principal"
          sx={{
            bgcolor: colors.navigation,
            color: 'common.white',
            width: { xs: 'auto', md: layout.sidebarWidth },
            flexShrink: 0,
            p: 2,
          }}
        >
          {navigation.map((entry) => (
            <Box key={entry.group} component="section" aria-label={entry.group} sx={{ mb: 2 }}>
              <Typography component="p" variant="body2" sx={{ opacity: 0.85, mb: 0.5 }}>
                {entry.group}
              </Typography>
              <Box component="ul" sx={{ listStyle: 'none', p: 0, m: 0 }}>
                {entry.items.map((route) => (
                  <li key={route.id}>
                    <RouterLink
                      to={route.pattern}
                      current={route.id === currentRouteId}
                      sx={{
                        display: 'block',
                        color: 'common.white',
                        borderRadius: `${opslogTokens.shape.controlRadius}px`,
                        px: 1.5,
                        py: 1,
                        bgcolor:
                          route.id === currentRouteId ? colors.navigationActive : 'transparent',
                        '&:hover': { bgcolor: colors.navigationActive },
                      }}
                    >
                      {route.nav?.label}
                    </RouterLink>
                  </li>
                ))}
              </Box>
            </Box>
          ))}
        </Box>
        <Box
          component="main"
          id="contenido"
          ref={main}
          tabIndex={-1}
          sx={{ flex: 1, minWidth: 0, p: { xs: 2, md: `${layout.contentPadding}px` } }}
        >
          {children}
        </Box>
      </Box>
    </Box>
  );
}
