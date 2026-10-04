import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
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
export function UiState({ kind, title, description, actionLabel, onAction }: UiStateProps) {
  const state = copy[kind];
  return (
    <Alert
      severity={state.severity}
      role={kind === 'error' ? 'alert' : 'status'}
      icon={kind === 'loading' ? <CircularProgress size={20} aria-label="Cargando" /> : undefined}
    >
      <Stack spacing={1}>
        <Typography component="h2" variant="subtitle1">
          {title ?? state.title}
        </Typography>
        <Typography variant="body2">{description ?? state.description}</Typography>
        {actionLabel && onAction && (
          <Button onClick={onAction} variant="outlined" size="small">
            {actionLabel}
          </Button>
        )}
      </Stack>
    </Alert>
  );
}
