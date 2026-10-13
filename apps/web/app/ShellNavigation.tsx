import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import React from 'react';
import { opslogTokens } from '@opslog/ui';
import { navIcons } from './navIcons';
import { RouterLink } from './router';
import type { NavGroup, RouteDefinition } from './routes';

const { colors, shape } = opslogTokens;

/** Grouped navigation links of the shell sidebar; the current screen is marked with `aria-current`. */
export function ShellNavigation({
  groups,
  currentRouteId,
}: {
  groups: readonly { group: NavGroup; items: readonly RouteDefinition[] }[];
  currentRouteId: string | null;
}) {
  return (
    <>
      {groups.map((entry) => (
        <Box key={entry.group} component="section" aria-label={entry.group} sx={{ mb: 2.5 }}>
          <Typography
            component="p"
            variant="overline"
            sx={{ color: colors.navigationGroup, px: 1.5, mb: 0.5, display: 'block' }}
          >
            {entry.group}
          </Typography>
          <Box component="ul" sx={{ listStyle: 'none', p: 0, m: 0 }}>
            {entry.items.map((route) => {
              const current = route.id === currentRouteId;
              const Icon = navIcons[route.id];
              return (
                <li key={route.id}>
                  <RouterLink
                    to={route.pattern}
                    current={current}
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 1.5,
                      minHeight: 38,
                      px: 1.5,
                      mb: 0.25,
                      borderRadius: `${shape.controlRadius}px`,
                      color: current ? colors.navigationActiveText : colors.navigationText,
                      bgcolor: current ? colors.navigationActive : 'transparent',
                      fontWeight: current ? 600 : 500,
                      '&:hover': {
                        bgcolor: current ? colors.navigationActive : colors.surfaceSubtle,
                        color: current ? colors.navigationActiveText : colors.text,
                      },
                    }}
                  >
                    {Icon && <Icon fontSize="small" aria-hidden="true" />}
                    {route.nav?.label}
                  </RouterLink>
                </li>
              );
            })}
          </Box>
        </Box>
      ))}
    </>
  );
}
