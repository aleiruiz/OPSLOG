import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import type { BffWebhookEndpoint } from '@opslog/contracts';
import React from 'react';
import {
  Button,
  ConfirmDialog,
  InlineAlert,
  PageHeader,
  Panel,
  StatusBadge,
  UiState,
} from '@opslog/ui';
import { ResourceView, useResource } from '../../app/resource';
import { useSession } from '../../auth/session';
import { DeliveriesPanel } from './DeliveriesPanel';
import { EndpointForm, type Saved } from './EndpointForm';
import { copy, eventLabels } from './labels';
import { SecretNotice } from './SecretNotice';

type Dialog =
  | { readonly kind: 'rotate'; readonly endpoint: BffWebhookEndpoint }
  | { readonly kind: 'remove'; readonly endpoint: BffWebhookEndpoint };

const until = (iso: string) => iso.replace('T', ' ').slice(0, 16);

function EndpointCard({
  endpoint,
  onEdit,
  onAsk,
  onTest,
  onHistory,
  open,
}: {
  readonly endpoint: BffWebhookEndpoint;
  readonly onEdit: () => void;
  readonly onAsk: (dialog: Dialog) => void;
  readonly onTest: () => void;
  readonly onHistory: () => void;
  readonly open: boolean;
}) {
  const state = endpoint.disabled
    ? { label: copy.disabled, tone: 'danger' as const }
    : endpoint.active
      ? { label: copy.enabled, tone: 'success' as const }
      : { label: copy.inactive, tone: 'neutral' as const };
  return (
    <Panel title={endpoint.url}>
      <StatusBadge label={state.label} tone={state.tone} />
      {endpoint.disabled && <InlineAlert severity="error">{copy.disabledHelp}</InlineAlert>}
      {endpoint.previousSecretUntil !== null && (
        <InlineAlert severity="info">
          {copy.graceUntil(until(endpoint.previousSecretUntil))}
        </InlineAlert>
      )}
      <Typography variant="body2" sx={{ mt: 1 }}>
        {endpoint.events.map((event) => eventLabels[event]).join(', ')}
      </Typography>
      <Box sx={{ mt: 2, display: 'flex', gap: 1, flexWrap: 'wrap' }}>
        <Button variant="outlined" onClick={onEdit}>{`${copy.edit} ${endpoint.url}`}</Button>
        <Button variant="outlined" onClick={onHistory} aria-expanded={open}>
          {`${copy.history} ${endpoint.url}`}
        </Button>
        <Button variant="outlined" disabled={!endpoint.active} onClick={onTest}>
          {`${copy.test} ${endpoint.url}`}
        </Button>
        <Button variant="outlined" onClick={() => onAsk({ kind: 'rotate', endpoint })}>
          {`${copy.rotate} ${endpoint.url}`}
        </Button>
        <Button variant="outlined" onClick={() => onAsk({ kind: 'remove', endpoint })}>
          {`${copy.remove} ${endpoint.url}`}
        </Button>
      </Box>
      {open && <DeliveriesPanel endpointId={endpoint.id} refreshKey={endpoint.version} />}
    </Panel>
  );
}

/** `/configuracion/integraciones`: webhook endpoints, their secret (shown once) and the delivery history. */
export function IntegrationsScreen() {
  const { ports, markExpired } = useSession();
  const { state, reload } = useResource(() => ports.integrations.list(), [ports]);
  const [editing, setEditing] = React.useState<BffWebhookEndpoint | 'new' | null>(null);
  const [secret, setSecret] = React.useState<string | null>(null);
  const [dialog, setDialog] = React.useState<Dialog | null>(null);
  const [history, setHistory] = React.useState<string | null>(null);
  const [tick, setTick] = React.useState(0);
  const [busy, setBusy] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const saved = ({ endpoint, secret: shown }: Saved) => {
    setEditing(null);
    setSecret(shown);
    setHistory(endpoint.id);
    reload();
  };
  const fail = (status: number) => {
    if (status === 401) markExpired();
    else setProblem(status === 409 ? copy.conflict : copy.saveError);
  };
  const confirm = async () => {
    if (!dialog) return;
    setBusy(true);
    setProblem(null);
    if (dialog.kind === 'remove') {
      const result = await ports.integrations.remove(dialog.endpoint.id);
      if (result.ok) setHistory((current) => (current === dialog.endpoint.id ? null : current));
      else fail(result.error.status);
      if (result.ok) reload();
    } else {
      const result = await ports.integrations.rotate(dialog.endpoint.id, dialog.endpoint.version);
      if (result.ok) {
        setSecret(result.value.secret);
        reload();
      } else fail(result.error.status);
    }
    setBusy(false);
    setDialog(null);
  };
  const sendTest = async (endpoint: BffWebhookEndpoint) => {
    setProblem(null);
    const result = await ports.integrations.test(endpoint.id);
    if (result.ok) {
      setNotice(copy.testSent);
      setHistory(endpoint.id);
      setTick((count) => count + 1);
    } else fail(result.error.status);
  };

  return (
    <>
      <PageHeader
        eyebrow={copy.eyebrow}
        title={copy.title}
        actions={
          <Button
            disabled={
              state.status !== 'ready' ||
              state.data.items.length >= state.data.max ||
              editing !== null
            }
            onClick={() => setEditing('new')}
          >
            {copy.add}
          </Button>
        }
      />
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        {copy.description}
      </Typography>
      {secret !== null && <SecretNotice secret={secret} onDone={() => setSecret(null)} />}
      {problem && <InlineAlert severity="error">{problem}</InlineAlert>}
      {notice && <InlineAlert severity="success">{notice}</InlineAlert>}
      {editing !== null && (
        <EndpointForm
          key={editing === 'new' ? 'new' : editing.id}
          endpoint={editing === 'new' ? null : editing}
          onSaved={saved}
          onCancel={() => setEditing(null)}
        />
      )}
      <ResourceView state={state} onRetry={reload}>
        {(data) => (
          <>
            <Typography variant="caption" color="text.secondary">
              {data.items.length >= data.max ? copy.limitReached : copy.limit(data.max)}
            </Typography>
            {data.items.length === 0 ? (
              <UiState kind="empty" title={copy.emptyTitle} description={copy.emptyDescription} />
            ) : (
              data.items.map((endpoint) => (
                <EndpointCard
                  key={`${endpoint.id}:${endpoint.version}:${tick}`}
                  endpoint={endpoint}
                  open={history === endpoint.id}
                  onEdit={() => setEditing(endpoint)}
                  onAsk={setDialog}
                  onTest={() => void sendTest(endpoint)}
                  onHistory={() =>
                    setHistory((current) => (current === endpoint.id ? null : endpoint.id))
                  }
                />
              ))
            )}
          </>
        )}
      </ResourceView>
      {dialog && (
        <ConfirmDialog
          title={dialog.kind === 'rotate' ? copy.rotateTitle : copy.removeTitle}
          description={dialog.kind === 'rotate' ? copy.rotateDescription : copy.removeDescription}
          confirmLabel={dialog.kind === 'rotate' ? copy.rotate : copy.remove}
          confirmTone={dialog.kind === 'rotate' ? 'primary' : 'danger'}
          busy={busy}
          onConfirm={() => void confirm()}
          onCancel={() => setDialog(null)}
        />
      )}
    </>
  );
}
