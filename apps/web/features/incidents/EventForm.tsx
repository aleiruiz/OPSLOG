import React from 'react';
import Box from '@mui/material/Box';
import { Button, InlineAlert } from '@opslog/ui';
import type { BffIncident, BffIncidentSuggestions } from '@opslog/contracts';
import type { DirectoryOption } from '../maintenance/directory';
import { EventFields, type EventGroup } from './EventFields';
import {
  fieldsFromEdits,
  hasEdits,
  type EventEdits,
  type EventFields as Fields,
} from './eventEdits';

/** How a save ended; a failure carries the neutral message to show next to the unsent fields. */
export type SubmitOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string; readonly stale?: boolean };

/**
 * One group of event fields with its own save. It keeps what the person typed and has not sent (`edits`) apart
 * from the case, so a reload after a conflict refreshes everything else and keeps those edits. The parent
 * decides whether the fields create a draft or change a case; this form only collects them.
 */
export function EventForm({
  label,
  incident,
  groups,
  zone,
  suggestions = null,
  drivers = [],
  submitLabel = 'Guardar cambios',
  allowEmpty = false,
  actions,
  onSubmit,
  onReload,
}: {
  label: string;
  /** `null` while the draft does not exist yet (every field is writable). */
  incident: BffIncident | null;
  groups: readonly EventGroup[];
  zone: string;
  suggestions?: BffIncidentSuggestions | null;
  drivers?: readonly DirectoryOption[];
  submitLabel?: string;
  /** Lets a wizard step continue without saving when nothing changed. */
  allowEmpty?: boolean;
  actions?: React.ReactNode;
  onSubmit: (fields: Fields) => Promise<SubmitOutcome>;
  /** Refreshes the case after a conflict; unsent edits stay in this form. */
  onReload?: () => void;
}) {
  const [edits, setEdits] = React.useState<EventEdits>({});
  const [busy, setBusy] = React.useState(false);
  const [problem, setProblem] = React.useState<{ message: string; stale: boolean } | null>(null);
  const idPrefix = React.useId();
  const pristine = !hasEdits(edits);
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const outcome = await onSubmit(fieldsFromEdits(edits, incident, zone));
    setBusy(false);
    if (outcome.ok) setEdits({});
    else setProblem({ message: outcome.message, stale: outcome.stale === true });
  };
  return (
    <Box
      component="form"
      aria-label={label}
      noValidate
      onSubmit={(event: React.FormEvent) => {
        event.preventDefault();
        void submit();
      }}
      sx={{ display: 'grid', gap: 2, maxWidth: 720 }}
    >
      {problem && (
        <InlineAlert
          severity={problem.stale ? 'warning' : 'error'}
          {...(problem.stale && onReload
            ? {
                action: (
                  <Button
                    color="inherit"
                    onClick={() => {
                      setProblem(null);
                      onReload();
                    }}
                  >
                    Recargar
                  </Button>
                ),
              }
            : {})}
        >
          {problem.message}
        </InlineAlert>
      )}
      {groups.map((group) => (
        <EventFields
          key={group}
          group={group}
          idPrefix={`${idPrefix}-${group}`}
          incident={incident}
          edits={edits}
          zone={zone}
          suggestions={suggestions}
          drivers={drivers}
          onEdit={setEdits}
        />
      ))}
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
        {actions}
        <Button type="submit" variant="contained" loading={busy} disabled={pristine && !allowEmpty}>
          {submitLabel}
        </Button>
      </Box>
    </Box>
  );
}
