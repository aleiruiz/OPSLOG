import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import React from 'react';
import { Button, StatusBadge } from '@opslog/ui';
import { RouterLink } from '../app/router';
import { useResource, type ResourceState } from '../app/resource';
import type { Result } from '../app/types';
import { useSession } from '../auth/session';
import { alertsPath } from './labels';

export interface AlertsSummaryData {
  readonly expired: number;
  readonly expiring: number;
  readonly windowDays: number;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** Presentational summary: how many documents and policies are expired or about to expire. */
export function AlertsSummaryView({
  state,
  onRetry,
}: {
  state: ResourceState<AlertsSummaryData>;
  onRetry: () => void;
}) {
  // Best effort on the landing page: a person without access or with an expired session just does not see it.
  if (state.status === 'forbidden' || state.status === 'expired') return null;
  return (
    <Box component="section" aria-labelledby="alerts-summary-title" sx={{ mt: 3, maxWidth: 720 }}>
      <Typography id="alerts-summary-title" component="h2" variant="h6">
        Vencimientos
      </Typography>
      {state.status === 'loading' && (
        <Typography color="text.secondary" variant="body2" role="status">
          Cargando vencimientos…
        </Typography>
      )}
      {state.status === 'error' && (
        <Box sx={{ mt: 1 }}>
          <Typography variant="body2" sx={{ mb: 1 }}>
            No pudimos cargar el resumen de vencimientos.
          </Typography>
          <Button variant="outlined" onClick={onRetry}>
            Reintentar
          </Button>
        </Box>
      )}
      {state.status === 'ready' && (
        <Box sx={{ mt: 1, display: 'flex', flexDirection: 'column', gap: 1 }}>
          {state.data.expired === 0 && state.data.expiring === 0 ? (
            <Typography variant="body2">
              {`Ningún documento ni seguro vence en los próximos ${plural(state.data.windowDays, 'día', 'días')}.`}
            </Typography>
          ) : (
            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
              <StatusBadge
                label={plural(state.data.expired, 'vencido', 'vencidos')}
                tone={state.data.expired > 0 ? 'danger' : 'neutral'}
              />
              <StatusBadge
                label={`${plural(state.data.expiring, 'por vencer', 'por vencer')} en ${plural(state.data.windowDays, 'día', 'días')}`}
                tone={state.data.expiring > 0 ? 'warning' : 'neutral'}
              />
            </Box>
          )}
          <RouterLink to={alertsPath} sx={{ color: 'primary.main', textDecoration: 'underline' }}>
            Ver alertas
          </RouterLink>
        </Box>
      )}
    </Box>
  );
}

/** Home summary of expiry alerts. Two cheap reads (one row each): only the totals are used. Requires `view`. */
export function AlertsSummary() {
  const { ports } = useSession();
  const { state, reload } = useResource<AlertsSummaryData>(async (): Promise<
    Result<AlertsSummaryData>
  > => {
    const [expired, expiring] = await Promise.all([
      ports.alerts.list({ limit: 25, severity: 'expired' }),
      ports.alerts.list({ limit: 25, severity: 'expiring' }),
    ]);
    if (!expired.ok) return expired;
    if (!expiring.ok) return expiring;
    return {
      ok: true,
      value: {
        expired: expired.value.total,
        expiring: expiring.value.total,
        windowDays: expiring.value.windowDays,
      },
    };
  }, [ports]);
  return <AlertsSummaryView state={state} onRetry={reload} />;
}
