import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import React from 'react';
import { Button, Panel, StatusBadge } from '@opslog/ui';
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
    <Panel title="Asignaciones e historial">
      <ResourceView state={state} onRetry={reload}>
        {(page) => {
          const items = [...page.items, ...extra];
          return items.length === 0 ? (
            <Typography color="text.secondary">No hay asignaciones registradas.</Typography>
          ) : (
            <>
              <Box component="ul" sx={{ p: 0, m: 0, listStyle: 'none' }}>
                {items.map((assignment) => {
                  const status = statusPresentation[isCurrent(assignment) ? 'current' : 'ended'];
                  return (
                    <Box
                      component="li"
                      key={assignment.id}
                      sx={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        alignItems: 'center',
                        columnGap: 1.5,
                        rowGap: 0.5,
                        py: 1.5,
                        borderBottom: 1,
                        borderColor: 'divider',
                        '&:first-of-type': { pt: 0 },
                        '&:last-of-type': { borderBottom: 0, pb: 0 },
                      }}
                    >
                      <RouterLink
                        to={`/flota/asignaciones/${encodeURIComponent(assignment.id)}`}
                        sx={{
                          color: 'primary.main',
                          fontWeight: 500,
                          textDecoration: 'underline',
                          textUnderlineOffset: '3px',
                        }}
                      >
                        {typeLabel(assignment.type)} · {formatDateTime(assignment.startedAt)}
                      </RouterLink>
                      <StatusBadge label={status.label} tone={status.tone} />
                      {assignment.endedAt !== null && (
                        <Typography component="span" variant="body2" color="text.secondary">
                          {'Fin: '}
                          {formatDateTime(assignment.endedAt)}
                        </Typography>
                      )}
                    </Box>
                  );
                })}
              </Box>
              {notice && (
                <Typography role="alert" color="error.main">
                  {notice}
                </Typography>
              )}
              {cursor && (
                <Button variant="outlined" loading={busy} onClick={() => void loadMore()}>
                  Cargar más asignaciones
                </Button>
              )}
            </>
          );
        }}
      </ResourceView>
    </Panel>
  );
}
