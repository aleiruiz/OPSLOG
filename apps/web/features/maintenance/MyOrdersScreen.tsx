import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { Button, PageHeader, StatusBadge, UiState } from '@opslog/ui';
import { COMMAND_LABELS, KIND_LABELS, STATUS_LABELS, STATUS_TONES, formatDate } from './labels';
import { useDirectory, vehicleLabel } from './directory';
import type { MaintenancePorts } from './ports';
import { errorKind, useResult } from './useResult';
import { availableCommands, isAssignedTo, type MaintenanceViewer } from './workflow';

const ACTIVE = ['assigned', 'in_progress', 'completed', 'scheduled'];

/**
 * S16: the mechanic's own orders, usable at 360 px. The server already limits the list to orders
 * assigned to the caller; the client filter only orders and labels them, it is not an authorization.
 */
export function MyOrdersScreen({
  ports,
  viewer,
  onOpen,
  onExpired,
}: {
  ports: MaintenancePorts;
  viewer: MaintenanceViewer;
  onOpen: (orderId: string) => void;
  onExpired: () => void;
}) {
  const directory = useDirectory();
  const { state, reload } = useResult(() => ports.orders.list(), [ports], onExpired);
  const header = <PageHeader title="Mis órdenes" description="Órdenes asignadas a ti." />;
  if (state.status === 'loading')
    return (
      <Box>
        {header}
        <UiState kind="loading" />
      </Box>
    );
  if (state.status === 'error')
    return (
      <Box>
        {header}
        <UiState kind={errorKind(state.error)} actionLabel="Reintentar" onAction={reload} />
      </Box>
    );
  const mine = state.data
    .filter((order) => isAssignedTo(viewer, order) && ACTIVE.includes(order.status))
    .sort((a, b) => (a.scheduledDate ?? '9999').localeCompare(b.scheduledDate ?? '9999'));
  return (
    <Box sx={{ maxWidth: 640 }}>
      {header}
      {mine.length === 0 ? (
        <UiState
          kind="empty"
          title="No tienes órdenes asignadas"
          description="Cuando te asignen una orden aparecerá aquí."
        />
      ) : (
        <Stack component="ul" spacing={2} sx={{ listStyle: 'none', p: 0, m: 0 }}>
          {mine.map((order) => {
            const next = availableCommands(order, viewer)[0];
            return (
              <Card component="li" key={order.id} sx={{ p: 2 }}>
                <Stack spacing={1}>
                  <Typography component="h2" variant="h6" sx={{ overflowWrap: 'anywhere' }}>
                    {order.description ?? `Orden ${KIND_LABELS[order.kind].toLowerCase()}`}
                  </Typography>
                  <StatusBadge
                    label={STATUS_LABELS[order.status]}
                    tone={STATUS_TONES[order.status]}
                  />
                  <Typography variant="body2" color="text.secondary">
                    {vehicleLabel(directory, order.vehicleId)} · Programada:{' '}
                    {formatDate(order.scheduledDate)}
                  </Typography>
                  <Button variant="contained" onClick={() => onOpen(order.id)} fullWidth>
                    {next ? `Abrir para ${COMMAND_LABELS[next].toLowerCase()}` : 'Abrir orden'}
                  </Button>
                </Stack>
              </Card>
            );
          })}
        </Stack>
      )}
    </Box>
  );
}
