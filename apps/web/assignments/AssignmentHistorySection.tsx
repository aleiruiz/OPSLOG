import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import React from 'react';
import { Button, StatusBadge } from '@opslog/ui';
import { ResourceView, useResource } from '../app/resource';
import { RouterLink } from '../app/router';
import type { AssignmentListQuery, VehicleAssignment } from '../app/types';
import { useSession } from '../auth/session';
import { formatDateTime, isCurrent, statusPresentation, typeLabel } from './labels';

/** Read-only assignment history embedded in vehicle and driver records (FR-053). */
export function AssignmentHistorySection({
  vehicleId,
  employeeId,
}: {
  vehicleId?: string;
  employeeId?: string;
}) {
  const { ports, markExpired } = useSession();
  const query: AssignmentListQuery = {
    limit: 100,
    ...(vehicleId ? { vehicleId } : {}),
    ...(employeeId ? { employeeId } : {}),
  };
  const { state, reload } = useResource(
    () => ports.assignments.list(query),
    [ports, vehicleId, employeeId],
  );
  const [extra, setExtra] = React.useState<VehicleAssignment[]>([]);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);
  React.useEffect(() => {
    setExtra([]);
    setCursor(state.status === 'ready' ? state.data.nextCursor : null);
    setNotice(null);
  }, [state]);

  const loadMore = async () => {
    if (!cursor) return;
    setBusy(true);
    setNotice(null);
    const result = await ports.assignments.list({ ...query, cursor });
    setBusy(false);
    if (result.ok) {
      setExtra((current) => [...current, ...result.value.items]);
      setCursor(result.value.nextCursor);
    } else if (result.error.status === 401) markExpired();
    else setNotice('No pudimos cargar más asignaciones.');
  };

  return (
    <Box component="section" aria-labelledby="assignment-history-title" sx={{ mt: 4 }}>
      <Typography id="assignment-history-title" component="h2" variant="h2" sx={{ mb: 2 }}>
        Asignaciones e historial
      </Typography>
      <ResourceView state={state} onRetry={reload}>
        {(page) => {
          const items = [...page.items, ...extra];
          return items.length === 0 ? (
            <Typography color="text.secondary">No hay asignaciones registradas.</Typography>
          ) : (
            <>
              <Box component="ul" sx={{ p: 0, m: 0, listStyle: 'none', display: 'grid', gap: 1 }}>
                {items.map((assignment) => {
                  const status = statusPresentation[isCurrent(assignment) ? 'current' : 'ended'];
                  return (
                    <Box
                      component="li"
                      key={assignment.id}
                      sx={{ borderBottom: 1, borderColor: 'divider', py: 1 }}
                    >
                      <RouterLink
                        to={`/flota/asignaciones/${encodeURIComponent(assignment.id)}`}
                        sx={{ color: 'primary.main', textDecoration: 'underline' }}
                      >
                        {typeLabel(assignment.type)} · {formatDateTime(assignment.startedAt)}
                      </RouterLink>
                      {' · '}
                      <StatusBadge label={status.label} tone={status.tone} />
                      {assignment.endedAt !== null && (
                        <Typography component="span" variant="body2" color="text.secondary">
                          {' · Fin: '}
                          {formatDateTime(assignment.endedAt)}
                        </Typography>
                      )}
                    </Box>
                  );
                })}
              </Box>
              {notice && (
                <Typography role="alert" color="error.main" sx={{ mt: 1 }}>
                  {notice}
                </Typography>
              )}
              {cursor && (
                <Button
                  variant="outlined"
                  loading={busy}
                  onClick={() => void loadMore()}
                  sx={{ mt: 2 }}
                >
                  Cargar más asignaciones
                </Button>
              )}
            </>
          );
        }}
      </ResourceView>
    </Box>
  );
}
