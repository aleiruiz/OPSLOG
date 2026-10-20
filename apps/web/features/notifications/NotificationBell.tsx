import NotificationsIcon from '@mui/icons-material/NotificationsNone';
import Badge from '@mui/material/Badge';
import IconButton from '@mui/material/IconButton';
import React from 'react';
import { useRouter } from '../../app/router';
import { badgeText, unreadAnnouncement } from './labels';
import type { NotificationsPorts } from './ports';

export const BELL_REFRESH_MS = 60_000;

/**
 * Bell of the top bar with the unread counter. The count is read on mount, on every change of screen
 * (so marking notices read is reflected at once) and every minute; a failure keeps the last number.
 */
export function NotificationBell({
  ports,
  onExpired,
  disabled = false,
  refreshMs = BELL_REFRESH_MS,
}: {
  ports: NotificationsPorts;
  onExpired: () => void;
  disabled?: boolean;
  refreshMs?: number;
}) {
  const router = useRouter();
  const [unread, setUnread] = React.useState(0);
  const expire = React.useRef(onExpired);
  expire.current = onExpired;

  React.useEffect(() => {
    let cancelled = false;
    const read = async () => {
      const result = await ports.count();
      if (cancelled) return;
      if (result.ok) setUnread(result.value.unread);
      else if (result.error.status === 401) expire.current();
    };
    void read();
    const timer = refreshMs > 0 ? setInterval(() => void read(), refreshMs) : undefined;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [ports, router.path, refreshMs]);

  const label = unreadAnnouncement(unread);
  return (
    <IconButton
      component="a"
      href={`${router.basename}/notificaciones`}
      aria-label={label}
      {...(disabled ? { 'aria-disabled': true, tabIndex: -1 } : {})}
      onClick={(event: React.MouseEvent<HTMLElement>) => {
        event.preventDefault();
        if (!disabled) router.navigate('/notificaciones');
      }}
      sx={{ flexShrink: 0 }}
    >
      <Badge
        badgeContent={unread > 0 ? badgeText(unread) : 0}
        color="error"
        // The counter is part of the accessible name above; the visual badge adds nothing for readers.
        slotProps={{ badge: { 'aria-hidden': true } as never }}
        data-testid="notification-count"
      >
        <NotificationsIcon aria-hidden="true" />
      </Badge>
    </IconButton>
  );
}
