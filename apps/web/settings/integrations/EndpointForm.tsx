import Box from '@mui/material/Box';
import type { BffWebhookEndpoint, BffWebhookEvent } from '@opslog/contracts';
import { BFF_WEBHOOK_EVENTS } from '@opslog/contracts';
import React from 'react';
import { Button, CheckField, Field, InlineAlert, Panel } from '@opslog/ui';
import { useSession } from '../../auth/session';
import { copy, eventLabels } from './labels';

export interface Saved {
  readonly endpoint: BffWebhookEndpoint;
  readonly secret: string | null;
}

/** Creates an endpoint or edits one (with the version it was read at). */
export function EndpointForm({
  endpoint,
  onSaved,
  onCancel,
}: {
  readonly endpoint: BffWebhookEndpoint | null;
  readonly onSaved: (saved: Saved) => void;
  readonly onCancel: () => void;
}) {
  const { ports, markExpired } = useSession();
  const [url, setUrl] = React.useState(endpoint?.url ?? 'https://');
  const [events, setEvents] = React.useState<readonly BffWebhookEvent[]>(endpoint?.events ?? []);
  const [active, setActive] = React.useState(endpoint?.active ?? true);
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const toggle = (event: BffWebhookEvent, on: boolean) =>
    setEvents((current) => (on ? [...current, event] : current.filter((item) => item !== event)));
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (events.length === 0) return setError(copy.noEvents);
    setSaving(true);
    setError(null);
    const ordered = BFF_WEBHOOK_EVENTS.filter((item) => events.includes(item));
    const result = endpoint
      ? await ports.integrations.update(endpoint.id, {
          version: endpoint.version,
          url,
          events: ordered,
          active,
        })
      : await ports.integrations.create({ url, events: ordered, active });
    setSaving(false);
    if (result.ok)
      return onSaved(
        'secret' in result.value
          ? { endpoint: result.value.endpoint, secret: result.value.secret }
          : { endpoint: result.value, secret: null },
      );
    if (result.error.status === 401) return markExpired();
    setError(
      result.error.status === 400
        ? copy.invalidUrl
        : result.error.status === 409
          ? copy.conflict
          : copy.saveError,
    );
  };
  return (
    <Panel title={endpoint ? copy.edit : copy.add}>
      <Box component="form" onSubmit={(event) => void submit(event)} noValidate>
        <Field
          label={copy.url}
          required
          fullWidth
          disabled={saving}
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          helperText={copy.urlHelp}
        />
        <Box component="fieldset" sx={{ border: 0, p: 0, my: 2 }}>
          <legend>{copy.events}</legend>
          {BFF_WEBHOOK_EVENTS.map((item) => (
            <CheckField
              key={item}
              label={eventLabels[item]}
              checked={events.includes(item)}
              onChange={(on) => toggle(item, on)}
            />
          ))}
        </Box>
        <CheckField label={copy.active} checked={active} onChange={setActive} />
        {error && <InlineAlert severity="error">{error}</InlineAlert>}
        <Box sx={{ mt: 2, display: 'flex', gap: 2 }}>
          <Button type="submit" disabled={saving}>
            {copy.save}
          </Button>
          <Button variant="outlined" disabled={saving} onClick={onCancel}>
            {copy.cancel}
          </Button>
        </Box>
      </Box>
    </Panel>
  );
}
