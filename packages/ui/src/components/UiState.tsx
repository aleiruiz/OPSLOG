import React from 'react';
import ErrorOutline from '@mui/icons-material/ErrorOutline';
import InboxOutlined from '@mui/icons-material/InboxOutlined';
import LockOutlined from '@mui/icons-material/LockOutlined';
import SearchOffOutlined from '@mui/icons-material/SearchOffOutlined';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { opslogTokens, statusColors } from '../tokens';
export type UiStateKind =
  | 'loading'
  | 'empty'
  | 'no-results'
  | 'error'
  | 'no-permission'
  | 'incomplete'
  | 'expired'
  | 'closed'
  | 'success'
  | 'session-expired';
export type UiStateProps = {
  kind: UiStateKind;
  title?: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
};
const copy: Record<
  UiStateKind,
  { title: string; description: string; severity: 'info' | 'warning' | 'error' | 'success' }
> = {
  loading: {
    title: 'Cargando',
    description: 'Estamos preparando la información.',
    severity: 'info',
  },
  empty: {
    title: 'Aún no hay registros',
    description: 'Cuando existan registros aparecerán aquí.',
    severity: 'info',
  },
  'no-results': {
    title: 'Sin resultados',
    description: 'Prueba con otros filtros o términos de búsqueda.',
    severity: 'info',
  },
  error: {
    title: 'No pudimos cargar la información',
    description: 'Intenta nuevamente.',
    severity: 'error',
  },
  'no-permission': {
    title: 'No tienes acceso',
    description: 'Solicita acceso a una persona administradora.',
    severity: 'warning',
  },
  incomplete: {
    title: 'Información incompleta',
    description: 'Faltan datos para continuar.',
    severity: 'warning',
  },
  expired: {
    title: 'Vencido',
    description: 'Este elemento requiere renovación o revisión.',
    severity: 'warning',
  },
  closed: {
    title: 'Cerrado',
    description: 'Este registro es histórico y no admite cambios.',
    severity: 'info',
  },
  success: {
    title: 'Listo',
    description: 'La operación se completó correctamente.',
    severity: 'success',
  },
  'session-expired': {
    title: 'Sesión expirada',
    description: 'Vuelve a iniciar sesión para continuar.',
    severity: 'warning',
  },
};
/** States that stand for a whole list or screen: a centred block with an icon instead of a banner. */
const blockIcons: Partial<Record<UiStateKind, React.ReactNode>> = {
  empty: <InboxOutlined />,
  'no-results': <SearchOffOutlined />,
  'no-permission': <LockOutlined />,
  error: <ErrorOutline />,
};
const tones = {
  info: { foreground: opslogTokens.colors.primary, background: opslogTokens.colors.primarySoft },
  warning: statusColors.warning,
  error: statusColors.danger,
  success: statusColors.success,
};

/**
 * Empty, no results, no permission, loading and a failed load (an error with a retry action) are
 * blocks centred in their card; other states (form validation, expired, closed, success) stay
 * banners next to the content they describe.
 */
export function UiState({ kind, title, description, actionLabel, onAction }: UiStateProps) {
  const state = copy[kind];
  const action = actionLabel && onAction && (
    <Button onClick={onAction} variant="outlined" size="small">
      {actionLabel}
    </Button>
  );
  const block = kind === 'loading' || (kind in blockIcons && (kind !== 'error' || action));
  if (block) {
    const tone = tones[state.severity];
    return (
      <Box
        role={kind === 'error' ? 'alert' : 'status'}
        sx={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          textAlign: 'center',
          gap: 1,
          px: 2,
          py: { xs: 4, sm: 5 },
        }}
      >
        <Box
          aria-hidden={kind === 'loading' ? undefined : 'true'}
          sx={{
            width: 48,
            height: 48,
            mb: 0.5,
            borderRadius: '50%',
            display: 'grid',
            placeItems: 'center',
            color: tone.foreground,
            bgcolor: tone.background,
          }}
        >
          {kind === 'loading' ? (
            <CircularProgress size={22} aria-label="Cargando" sx={{ color: 'inherit' }} />
          ) : (
            blockIcons[kind]
          )}
        </Box>
        <Typography component="h2" variant="h3">
          {title ?? state.title}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 440 }}>
          {description ?? state.description}
        </Typography>
        {action && <Box sx={{ mt: 1 }}>{action}</Box>}
      </Box>
    );
  }
  return (
    <Alert severity={state.severity} role={kind === 'error' ? 'alert' : 'status'} sx={{ my: 2 }}>
      <Stack spacing={1}>
        <Typography component="h2" variant="subtitle1">
          {title ?? state.title}
        </Typography>
        <Typography variant="body2">{description ?? state.description}</Typography>
        {action}
      </Stack>
    </Alert>
  );
}
