import CloseIcon from '@mui/icons-material/Close';
import LogoutIcon from '@mui/icons-material/Logout';
import MenuIcon from '@mui/icons-material/Menu';
import Box from '@mui/material/Box';
import { useTheme } from '@mui/material/styles';
import Typography from '@mui/material/Typography';
import React from 'react';
import { Button, opslogTokens } from '@opslog/ui';
import type { Permission, SessionInfo } from './types';
import { useRouter } from './router';
import { routes, isAllowed, type NavGroup, type RouteDefinition } from './routes';
import { BrandMark } from './BrandMark';
import { ShellNavigation } from './ShellNavigation';

const { colors, layout } = opslogTokens;

const navGroups: readonly NavGroup[] = [
  'Inicio',
  'Plantilla',
  'Flota',
  'Operación',
  'Configuración',
];

/** Navigation entries the current permissions allow, grouped in the SPECS §8 order. */
export function visibleNavigation(
  can: (permission: Permission) => boolean,
): { group: NavGroup; items: RouteDefinition[] }[] {
  return navGroups
    .map((group) => ({
      group,
      items: routes.filter(
        (route) =>
          route.nav?.group === group &&
          isAllowed(route.access, can) &&
          (route.nav.requires === undefined || can(route.nav.requires)),
      ),
    }))
    .filter((entry) => entry.items.length > 0);
}

/** Same rules as the `.sr-only` class of the theme, as an `sx` object for breakpoint use. */
const visuallyHidden = {
  position: 'absolute',
  width: 1,
  height: 1,
  m: '-1px',
  p: 0,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: 0,
} as const;

const initials = (text: string) =>
  text
    .split(/\s+/)
    .filter((word) => word.length > 2)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase())
    .join('') || 'U';

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
  const theme = useTheme();
  const narrow = theme.breakpoints.down('md');
  const phone = theme.breakpoints.down('sm');
  const { path } = useRouter();
  const main = React.useRef<HTMLElement>(null);
  const firstRender = React.useRef(true);
  // On narrow screens the navigation is a menu that opens under the top bar.
  const [menuOpen, setMenuOpen] = React.useState(false);
  const menuButton = React.useRef<HTMLButtonElement>(null);
  // Escape closes the open menu and returns focus to its button, as with any disclosure.
  React.useEffect(() => {
    if (!menuOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      setMenuOpen(false);
      menuButton.current?.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [menuOpen]);
  // Moving between screens would otherwise leave keyboard focus on a link that may have disappeared.
  React.useEffect(() => {
    setMenuOpen(false);
    if (firstRender.current) firstRender.current = false;
    else main.current?.focus();
  }, [path]);
  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        bgcolor: colors.background,
      }}
    >
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
          position: 'sticky',
          top: 0,
          zIndex: theme.zIndex.appBar,
          bgcolor: colors.surface,
          borderBottom: `1px solid ${colors.border}`,
          minHeight: layout.topBarHeight,
          px: { xs: 1.5, md: 3 },
          display: 'flex',
          alignItems: 'center',
          gap: { xs: 1, sm: 2 },
        }}
      >
        <Button
          ref={menuButton}
          variant="text"
          size="small"
          aria-expanded={menuOpen}
          aria-controls="navegacion-principal"
          {...(locked ? { disabled: true } : {})}
          onClick={() => setMenuOpen((open) => !open)}
          startIcon={menuOpen ? <CloseIcon /> : <MenuIcon />}
          sx={{ color: colors.text, minWidth: 0, display: { md: 'none' } }}
        >
          Menú
        </Button>
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            width: { md: layout.sidebarWidth - 24 },
          }}
        >
          <BrandMark />
        </Box>
        <Box
          role="group"
          aria-label="Empresa"
          sx={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            alignItems: 'baseline',
            gap: 0.75,
            overflow: 'hidden',
            whiteSpace: 'nowrap',
            textOverflow: 'ellipsis',
          }}
        >
          <Typography
            component="span"
            variant="body2"
            color="text.secondary"
            sx={{ display: { xs: 'none', sm: 'inline' } }}
          >
            Empresa:{' '}
          </Typography>
          <Typography
            component="strong"
            variant="body2"
            fontWeight={600}
            data-testid="shell-company"
            noWrap
          >
            {session.company.name}
          </Typography>
        </Box>
        <Box
          role="group"
          aria-label="Usuario"
          sx={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 1 }}
        >
          <Box
            aria-hidden="true"
            sx={{
              display: 'grid',
              placeItems: 'center',
              borderRadius: '50%',
              width: 32,
              height: 32,
              fontSize: 13,
              fontWeight: 600,
              bgcolor: colors.primarySoft,
              color: colors.primaryHover,
            }}
          >
            {initials(session.roleLabel)}
          </Box>
          <Typography
            component="span"
            variant="body2"
            data-testid="shell-user"
            sx={{ display: { xs: 'none', md: 'inline' } }}
          >
            {session.roleLabel}
          </Typography>
        </Box>
        <Button
          {...(locked ? { disabled: true } : {})}
          variant="outlined"
          size="small"
          onClick={onSignOut}
          startIcon={<LogoutIcon fontSize="small" />}
          sx={{
            flexShrink: 0,
            [phone]: { minWidth: 0, px: 1, '& .MuiButton-startIcon': { m: 0 } },
          }}
        >
          <Box component="span" sx={{ [phone]: visuallyHidden }}>
            Cerrar sesión
          </Box>
        </Button>
      </Box>
      <Box sx={{ display: 'flex', flex: 1, flexDirection: { xs: 'column', md: 'row' } }}>
        <Box
          component="nav"
          id="navegacion-principal"
          {...(locked ? { inert: true } : {})}
          aria-label="Principal"
          sx={{
            bgcolor: colors.navigation,
            borderRight: { md: `1px solid ${colors.border}` },
            width: { xs: 'auto', md: layout.sidebarWidth },
            flexShrink: 0,
            [narrow]: {
              display: menuOpen ? 'block' : 'none',
              borderBottom: `1px solid ${colors.border}`,
            },
          }}
        >
          <Box
            sx={{
              px: 1.5,
              py: 2.5,
              position: { md: 'sticky' },
              top: { md: layout.topBarHeight },
              maxHeight: { md: `calc(100vh - ${layout.topBarHeight}px)` },
              overflowY: { md: 'auto' },
            }}
          >
            <ShellNavigation groups={navigation} currentRouteId={currentRouteId} />
          </Box>
        </Box>
        <Box
          component="main"
          id="contenido"
          ref={main}
          tabIndex={-1}
          sx={{
            flex: 1,
            minWidth: 0,
            px: { xs: 2, md: `${layout.contentPadding}px` },
            py: { xs: 2.5, md: 3.5 },
          }}
        >
          <Box
            sx={{
              maxWidth: layout.contentMaxWidth,
              mx: 'auto',
              // Standard gap between the blocks of every screen (header, filters, notices, lists). Screens
              // render fragments, so their blocks land here or in the per-session wrapper of App; their own
              // margins still win and collapse.
              '& > * + *, & > div:last-child > * + *': { mt: 2 },
            }}
          >
            {children}
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
