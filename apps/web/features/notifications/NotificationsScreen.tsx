import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { BffNotification, BffNotificationKind } from '@opslog/contracts';
import { BFF_NOTIFICATION_KINDS } from '@opslog/contracts';
import React from 'react';
import { Button, CheckField, InlineAlert, PageHeader, StatusBadge, UiState } from '@opslog/ui';
import { RouterButton, RouterLink, linkSx } from '../../app/router';
import { useSession } from '../../auth/session';
import { copy, dayHeading, dayKey, kindLabels, severityLabels, severityTone } from './labels';
import { useNotificationList } from './useNotificationList';

const timeOf = (iso: string): string =>
  new Intl.DateTimeFormat('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false }).format(
    new Date(iso),
  );

function groupByDay(items: readonly BffNotification[]) {
  const groups: { key: string; items: BffNotification[] }[] = [];
  for (const item of items) {
    const key = dayKey(item.createdAt);
    const last = groups.at(-1);
    if (last?.key === key) last.items.push(item);
    else groups.push({ key, items: [item] });
  }
  return groups;
}

/** `/notificaciones`: the person's notices by day, newest first, with a link to what each is about. */
export function NotificationsScreen({ today }: { readonly today?: string | undefined }) {
  const { ports, markExpired } = useSession();
  const [unreadOnly, setUnreadOnly] = React.useState(false);
  const [kind, setKind] = React.useState<BffNotificationKind | ''>('');
  const [failed, setFailed] = React.useState(false);
  const list = useNotificationList({ unreadOnly, kind });
  const { state } = list;
  const todayKey = today ?? new Date().toISOString().slice(0, 10);

  const settle = (status: number): void => {
    if (status === 401) markExpired();
    else setFailed(true);
  };
  const read = async (item: BffNotification) => {
    setFailed(false);
    const result = await ports.notifications.markRead(item.id);
    if (!result.ok) return settle(result.error.status);
    list.patch(
      (items) => items.map((n) => (n.id === item.id ? result.value : n)),
      (unread) => (item.readAt === null ? Math.max(0, unread - 1) : unread),
    );
  };
  const readAll = async () => {
    setFailed(false);
    const result = await ports.notifications.markAllRead();
    if (!result.ok) return settle(result.error.status);
    const now = new Date().toISOString();
    list.patch(
      (items) => items.map((n) => (n.readAt === null ? { ...n, readAt: now } : n)),
      () => 0,
    );
  };

  return (
    <>
      <PageHeader
        eyebrow="Inicio"
        title={copy.title}
        description={copy.description}
        actions={
          <Stack direction="row" gap={1}>
            <RouterButton to="/notificaciones/preferencias">{copy.preferencesLink}</RouterButton>
            <Button
              variant="outlined"
              disabled={state.status !== 'ready' || state.unread === 0}
              onClick={() => void readAll()}
            >
              {copy.markAll}
            </Button>
          </Stack>
        }
      />
      <Stack direction={{ xs: 'column', sm: 'row' }} gap={2} alignItems={{ sm: 'center' }}>
        <CheckField label={copy.unreadOnly} checked={unreadOnly} onChange={setUnreadOnly} />
        <Box component="label" sx={{ display: 'flex', alignItems: 'center', gap: 1, fontSize: 14 }}>
          {copy.kindFilter}
          <select
            value={kind}
            onChange={(event) => setKind(event.target.value as BffNotificationKind | '')}
          >
            <option value="">{copy.allKinds}</option>
            {BFF_NOTIFICATION_KINDS.map((value) => (
              <option key={value} value={value}>
                {kindLabels[value]}
              </option>
            ))}
          </select>
        </Box>
      </Stack>
      {failed && <InlineAlert severity="error">{copy.error}</InlineAlert>}
      {state.status === 'loading' && <UiState kind="loading" />}
      {state.status === 'error' && (
        <UiState kind="error" title={copy.error} actionLabel="Reintentar" onAction={list.retry} />
      )}
      {state.status === 'ready' && state.items.length === 0 && (
        <UiState kind="empty" title={unreadOnly ? copy.emptyUnread : copy.empty} />
      )}
      {state.status === 'ready' &&
        groupByDay(state.items).map((group) => (
          <section key={group.key} aria-labelledby={`dia-${group.key}`}>
            <Typography variant="h2" component="h2" id={`dia-${group.key}`}>
              {dayHeading(group.key, todayKey)}
            </Typography>
            <Box component="ul" sx={{ listStyle: 'none', p: 0, m: 0 }}>
              {group.items.map((item) => (
                <Box
                  component="li"
                  key={item.id}
                  data-unread={item.readAt === null}
                  sx={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    gap: 1.5,
                    py: 1.25,
                    borderBottom: '1px solid',
                    borderColor: 'divider',
                    fontWeight: item.readAt === null ? 600 : 400,
                  }}
                >
                  <Typography
                    variant="body2"
                    color="text.secondary"
                    component="time"
                    dateTime={item.createdAt}
                  >
                    {timeOf(item.createdAt)}
                  </Typography>
                  <StatusBadge
                    label={severityLabels[item.severity]}
                    tone={severityTone[item.severity]}
                  />
                  <Box sx={{ flex: 1, minWidth: 220 }}>
                    <Typography variant="caption" color="text.secondary" display="block">
                      {kindLabels[item.eventKind]}
                      {item.readAt === null ? ` · ${copy.unread}` : ''}
                    </Typography>
                    <RouterLink to={item.link} sx={linkSx}>
                      {item.title}
                    </RouterLink>
                  </Box>
                  {item.readAt === null && (
                    <Button
                      size="small"
                      variant="text"
                      aria-label={`${copy.markOne}: ${item.title}`}
                      onClick={() => void read(item)}
                    >
                      {copy.markOne}
                    </Button>
                  )}
                </Box>
              ))}
            </Box>
          </section>
        ))}
      {state.status === 'ready' && state.items.length < state.total && (
        <Button variant="outlined" disabled={list.loadingMore} onClick={() => void list.more()}>
          {copy.more}
        </Button>
      )}
    </>
  );
}
