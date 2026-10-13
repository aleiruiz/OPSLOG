import { Panel, Timeline, UiState } from '@opslog/ui';
import { errorKind } from '../maintenance/useResult';
import { useIncidentEnv } from './env';
import { changedFieldsText, timelineTitle } from './labels';
import { formatDateTime } from './time';
import { useLive } from './useLive';

/**
 * Timeline: what happened to the case, newest first. The server records names of fields and structured facts
 * only, so an entry says who did what and when, never the values that changed.
 */
export function TimelineTab({ incidentId, version }: { incidentId: string; version: number }) {
  const env = useIncidentEnv();
  const timeline = useLive(
    () => env.ports.timeline(incidentId),
    [env.ports, incidentId, version],
    env.onExpired,
  );
  if (timeline.data === null)
    return timeline.error ? (
      <UiState
        kind={errorKind(timeline.error)}
        actionLabel="Reintentar"
        onAction={timeline.reload}
      />
    ) : (
      <UiState kind="loading" />
    );
  const entries = [...timeline.data.items].sort((a, b) => b.sequence - a.sequence);
  return (
    <Panel title="Historial del caso">
      {entries.length === 0 ? (
        <UiState kind="empty" title="Sin movimientos" description="Aún no hay movimientos." />
      ) : (
        <Timeline
          items={entries.map((entry) => {
            const description = [
              entry.actor.displayName,
              changedFieldsText(entry.changedFields),
              entry.comment,
            ]
              .filter(Boolean)
              .join(' · ');
            return {
              id: String(entry.sequence),
              title: timelineTitle(entry),
              date: formatDateTime(entry.occurredAt, env.zone),
              description,
            };
          })}
        />
      )}
    </Panel>
  );
}
