import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { Button, Notifications, Timeline } from '@opslog/ui';
import { ResourceView } from '../app/resource';
import type { HistoryProps } from './areaDetailState';
import { describeHistory, formatDateTime } from './labels';

export function History({
  props,
  nameOf,
}: {
  props: HistoryProps;
  nameOf: (areaId: string) => string | null;
}) {
  const { state } = props;
  return (
    <Box component="section" aria-labelledby="history-title" sx={{ mt: 4 }}>
      <Typography id="history-title" component="h2" variant="h2" sx={{ mb: 1 }}>
        Historial
      </Typography>
      {state.status === 'ready' ? (
        <>
          <Timeline
            items={state.data.items.map((entry) => ({
              id: entry.id,
              title: describeHistory(entry, nameOf),
              description: `Por ${entry.actorId} · versión ${entry.version}`,
              date: formatDateTime(entry.at),
            }))}
          />
          {props.notice && (
            <Box sx={{ my: 1 }}>
              <Notifications
                messages={[{ id: 'history-notice', text: props.notice, severity: 'error' }]}
              />
            </Box>
          )}
          {state.data.nextCursor && (
            <Button
              variant="outlined"
              loading={props.loadingMore ?? false}
              onClick={() => props.onLoadMore(state.data.nextCursor as string)}
            >
              Cargar más historial
            </Button>
          )}
        </>
      ) : (
        <ResourceView state={state} onRetry={props.onRetry}>
          {() => null}
        </ResourceView>
      )}
    </Box>
  );
}
