import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import type { BffNotificationPreference } from '@opslog/contracts';
import React from 'react';
import { Button, CheckField, InlineAlert, Panel, PageHeader } from '@opslog/ui';
import { ResourceView, useResource } from '../../app/resource';
import { RouterButton } from '../../app/router';
import { useSession } from '../../auth/session';
import { AdminPanel } from './AdminPanel';
import { copy } from './labels';

type Draft = Readonly<Record<string, { inApp: boolean; email: boolean }>>;

const draftOf = (rows: readonly BffNotificationPreference[]): Draft =>
  Object.fromEntries(rows.map((row) => [row.eventKind, { inApp: row.inApp, email: row.email }]));

function Matrix({ rows }: { readonly rows: readonly BffNotificationPreference[] }) {
  const { ports, markExpired } = useSession();
  const [draft, setDraft] = React.useState<Draft>(() => draftOf(rows));
  const [outcome, setOutcome] = React.useState<'idle' | 'saved' | 'failed'>('idle');
  const [saving, setSaving] = React.useState(false);
  const set = (kind: string, channel: 'inApp' | 'email', value: boolean) => {
    setOutcome('idle');
    setDraft((current) => ({
      ...current,
      [kind]: { ...(current[kind] as { inApp: boolean; email: boolean }), [channel]: value },
    }));
  };
  const save = async () => {
    setSaving(true);
    const result = await ports.notifications.savePreferences({
      items: rows
        .filter((row) => !row.mandatory)
        .map((row) => ({
          eventKind: row.eventKind,
          inApp: draft[row.eventKind]?.inApp ?? row.inApp,
          email: draft[row.eventKind]?.email ?? row.email,
        })),
    });
    setSaving(false);
    if (result.ok) {
      setDraft(draftOf(result.value.items));
      setOutcome('saved');
    } else if (result.error.status === 401) markExpired();
    else setOutcome('failed');
  };
  return (
    <Panel title={copy.matrixLabel} description={copy.preferencesDescription}>
      <Box
        component="table"
        aria-label={copy.matrixLabel}
        sx={{ width: '100%', borderCollapse: 'collapse' }}
      >
        <thead>
          <tr>
            <Box component="th" scope="col" sx={{ textAlign: 'left', py: 1 }}>
              {copy.kind}
            </Box>
            <th scope="col">{copy.inApp}</th>
            <th scope="col">{copy.email}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const value = draft[row.eventKind] ?? { inApp: row.inApp, email: row.email };
            const noteId = `nota-${row.eventKind}`;
            return (
              <Box
                component="tr"
                key={row.eventKind}
                sx={{ borderTop: '1px solid', borderColor: 'divider' }}
              >
                <Box component="th" scope="row" sx={{ textAlign: 'left', fontWeight: 500, py: 1 }}>
                  {row.label}
                  <Typography variant="caption" color="text.secondary" display="block" id={noteId}>
                    {row.mandatory ? `${copy.mandatory}. ${copy.mandatoryHelp}` : row.description}
                  </Typography>
                </Box>
                <Box component="td" sx={{ textAlign: 'center' }}>
                  <CheckField
                    label={`${copy.inApp}: ${row.label}`}
                    checked={value.inApp}
                    disabled={row.mandatory}
                    onChange={(checked) => set(row.eventKind, 'inApp', checked)}
                  />
                </Box>
                <Box component="td" sx={{ textAlign: 'center' }}>
                  {row.emailAvailable ? (
                    <CheckField
                      label={`${copy.email}: ${row.label}`}
                      checked={value.email}
                      onChange={(checked) => set(row.eventKind, 'email', checked)}
                    />
                  ) : (
                    <Typography variant="caption" color="text.secondary">
                      {copy.emailUnavailable}
                    </Typography>
                  )}
                </Box>
              </Box>
            );
          })}
        </tbody>
      </Box>
      <Box sx={{ mt: 2, display: 'flex', gap: 2, alignItems: 'center' }}>
        <Button disabled={saving} onClick={() => void save()}>
          {copy.save}
        </Button>
        {outcome === 'saved' && <InlineAlert severity="success">{copy.saved}</InlineAlert>}
        {outcome === 'failed' && <InlineAlert severity="error">{copy.saveError}</InlineAlert>}
      </Box>
    </Panel>
  );
}

/** `/notificaciones/preferencias`: channels by kind within what the company allows, and the company rules for its administrator. */
export function PreferencesScreen() {
  const { can, ports } = useSession();
  const { state, reload } = useResource(() => ports.notifications.preferences(), [ports]);
  return (
    <>
      <PageHeader
        eyebrow="Inicio"
        title={copy.preferencesTitle}
        actions={<RouterButton to="/notificaciones">{copy.back}</RouterButton>}
      />
      <ResourceView state={state} onRetry={reload}>
        {(data) => <Matrix rows={data.items} />}
      </ResourceView>
      {can('manage_config') && <AdminPanel />}
    </>
  );
}
