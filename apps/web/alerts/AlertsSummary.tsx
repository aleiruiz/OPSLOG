import ErrorOutline from '@mui/icons-material/ErrorOutline';
import NotificationsOutlined from '@mui/icons-material/NotificationsOutlined';
import ScheduleOutlined from '@mui/icons-material/ScheduleOutlined';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import React from 'react';
import { Button, Panel, StatCard } from '@opslog/ui';
import { RouterButton } from '../app/router';
import { useResource, type ResourceState } from '../app/resource';
import type { Result } from '../app/types';
import { useSession } from '../auth/session';
import { alertsPath } from './labels';

export interface AlertsSummaryData {
  readonly expired: number;
  readonly expiring: number;
  readonly windowDays: number;
}

const days = (count: number) => `${count} ${count === 1 ? 'día' : 'días'}`;

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
    <Panel
      title="Vencimientos"
      description="Documentos de vehículo, seguros y licencias."
      actions={
        state.status === 'ready' ? (
          <RouterButton to={alertsPath} variant="text" startIcon={<NotificationsOutlined />}>
            Ver alertas
          </RouterButton>
        ) : undefined
      }
    >
      {state.status === 'loading' && (
        <Typography color="text.secondary" variant="body2" role="status">
          Cargando vencimientos…
        </Typography>
      )}
      {state.status === 'error' && (
        <Box>
          <Typography variant="body2" sx={{ mb: 1 }}>
            No pudimos cargar el resumen de vencimientos.
          </Typography>
          <Button variant="outlined" onClick={onRetry}>
            Reintentar
          </Button>
        </Box>
      )}
      {state.status === 'ready' &&
        (state.data.expired === 0 && state.data.expiring === 0 ? (
          <Typography variant="body2">
            {`Ningún documento, seguro ni licencia vence en los próximos ${days(state.data.windowDays)}.`}
          </Typography>
        ) : (
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 2 }}>
            <StatCard
              label="Vencidos"
              value={state.data.expired}
              hint="Requieren renovación"
              tone={state.data.expired > 0 ? 'danger' : 'neutral'}
              icon={<ErrorOutline fontSize="small" />}
            />
            <StatCard
              label="Por vencer"
              value={state.data.expiring}
              hint={`En los próximos ${days(state.data.windowDays)}`}
              tone={state.data.expiring > 0 ? 'warning' : 'neutral'}
              icon={<ScheduleOutlined fontSize="small" />}
            />
          </Box>
        ))}
    </Panel>
  );
}

/** Totals of expired and expiring alerts. Two cheap reads (one page each): only the totals are used. */
export async function loadAlertsSummary(
  ports: ReturnType<typeof useSession>['ports'],
): Promise<Result<AlertsSummaryData>> {
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
}

/** Home summary of expiry alerts. Requires `view`. */
export function AlertsSummary() {
  const { ports } = useSession();
  const { state, reload } = useResource<AlertsSummaryData>(() => loadAlertsSummary(ports), [ports]);
  return <AlertsSummaryView state={state} onRetry={reload} />;
}
