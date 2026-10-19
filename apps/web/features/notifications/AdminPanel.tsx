import Typography from '@mui/material/Typography';
import type { BffNotificationKind, BffNotificationRule } from '@opslog/contracts';
import { BFF_NOTIFICATION_KINDS } from '@opslog/contracts';
import React from 'react';
import { Button, CheckField, InlineAlert, Panel } from '@opslog/ui';
import { ResourceView, useResource } from '../../app/resource';
import { useSession } from '../../auth/session';
import { copy, kindLabels } from './labels';

function RuleForm({ rule }: { readonly rule: BffNotificationRule }) {
  const { ports, markExpired } = useSession();
  const [emailKinds, setEmailKinds] = React.useState<readonly BffNotificationKind[]>(
    rule.emailKinds,
  );
  const [quietHours, setQuietHours] = React.useState(rule.quietHours);
  const [outcome, setOutcome] = React.useState<'idle' | 'saved' | 'failed'>('idle');
  const toggle = (kind: BffNotificationKind, on: boolean) => {
    setOutcome('idle');
    setEmailKinds((current) => (on ? [...current, kind] : current.filter((k) => k !== kind)));
  };
  const save = async () => {
    const result = await ports.notifications.saveRule({ emailKinds, quietHours });
    if (result.ok) setOutcome('saved');
    else if (result.error.status === 401) markExpired();
    else setOutcome('failed');
  };
  return (
    <>
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend>{copy.emailKinds}</legend>
        {BFF_NOTIFICATION_KINDS.map((kind) => (
          <CheckField
            key={kind}
            label={kindLabels[kind]}
            checked={emailKinds.includes(kind)}
            onChange={(on) => toggle(kind, on)}
          />
        ))}
      </fieldset>
      <CheckField
        label={copy.quietHours}
        checked={quietHours}
        onChange={(on) => {
          setOutcome('idle');
          setQuietHours(on);
        }}
      />
      <Button onClick={() => void save()}>{copy.saveRule}</Button>
      {outcome === 'saved' && <InlineAlert severity="success">{copy.ruleSaved}</InlineAlert>}
      {outcome === 'failed' && <InlineAlert severity="error">{copy.saveError}</InlineAlert>}
    </>
  );
}

/** Company rules (what may be e-mailed, quiet hours) and the deliveries that ran out of attempts. */
export function AdminPanel() {
  const { ports } = useSession();
  const rule = useResource(() => ports.notifications.rule(), [ports]);
  const failed = useResource(() => ports.notifications.failedDeliveries(), [ports]);
  return (
    <Panel title={copy.adminTitle} description={copy.adminDescription}>
      <ResourceView state={rule.state} onRetry={rule.reload}>
        {(data) => <RuleForm rule={data} />}
      </ResourceView>
      <Typography variant="h3" component="h3" sx={{ mt: 3 }}>
        {copy.failedTitle}
      </Typography>
      <ResourceView state={failed.state} onRetry={failed.reload}>
        {(data) =>
          data.items.length === 0 ? (
            <Typography variant="body2">{copy.failedEmpty}</Typography>
          ) : (
            <ul>
              {data.items.map((item) => (
                <li key={`${item.notificationId}-${item.channel}`}>
                  {kindLabels[item.eventKind]} ({item.channel === 'email' ? copy.email : copy.inApp}
                  ): {item.attempts} intentos{item.lastError ? `, ${item.lastError}` : ''}
                </li>
              ))}
            </ul>
          )
        }
      </ResourceView>
    </Panel>
  );
}
