import type { BffSubscriptionType } from '@opslog/contracts';
import React from 'react';
import { Button, InlineAlert } from '@opslog/ui';
import { useSession } from '../../auth/session';
import { copy } from './labels';

/**
 * «Seguir» / «Siguiendo» for a vehicle or an incident. It reads whether the person already follows the
 * record and toggles it. Detail screens mount it when MVP-INTEGRATE wires it in.
 */
export function FollowButton({
  type,
  entityId,
}: {
  readonly type: BffSubscriptionType;
  readonly entityId: string;
}) {
  const { ports, markExpired } = useSession();
  const [following, setFollowing] = React.useState<boolean | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setFollowing(null);
    void ports.notifications.subscriptions(type).then((result) => {
      if (cancelled) return;
      if (result.ok) setFollowing(result.value.items.some((item) => item.entityId === entityId));
      else if (result.error.status === 401) markExpired();
    });
    return () => {
      cancelled = true;
    };
  }, [ports, type, entityId]);

  if (following === null) return null;
  const toggle = async () => {
    setBusy(true);
    setFailed(false);
    const result = following
      ? await ports.notifications.unsubscribe(type, entityId)
      : await ports.notifications.subscribe(type, entityId);
    setBusy(false);
    if (result.ok) setFollowing(!following);
    else if (result.error.status === 401) markExpired();
    else setFailed(true);
  };
  return (
    <>
      <Button
        variant={following ? 'contained' : 'outlined'}
        size="small"
        aria-pressed={following}
        disabled={busy}
        onClick={() => void toggle()}
      >
        {following ? copy.following : copy.follow}
      </Button>
      {failed && <InlineAlert severity="error">{copy.followError}</InlineAlert>}
    </>
  );
}
