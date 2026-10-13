import Box from '@mui/material/Box';
import { Button, Notifications, Panel, Timeline } from '@opslog/ui';
import { ResourceView } from '../app/resource';
import type { HistoryProps } from './employeeDetailState';
import { describeHistory, formatDateTime } from './labels';

export function History({
  props,
  areaName,
}: {
  props: HistoryProps;
  areaName: (areaId: string) => string | null;
}) {
  const { state } = props;
  return (
    <Panel title="Historial">
      {state.status === 'ready' ? (
        <>
          <Timeline
            items={state.data.items.map((entry) => ({
              id: entry.id,
              title: describeHistory(entry, areaName),
              description: `${entry.reason ? `Motivo: ${entry.reason} · ` : ''}Por ${entry.actorId} · versión ${entry.version}`,
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
    </Panel>
  );
}
