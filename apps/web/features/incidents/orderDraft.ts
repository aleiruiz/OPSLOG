import React from 'react';
import type { BffIncident } from '@opslog/contracts';
import { defaultOrderDescription } from './repairLinking';
import { SubmitKeys } from './submit';

/**
 * The corrective order being registered from the case. It lives in the repair tab, above the dialog, so
 * closing and reopening the dialog neither forgets the order that was created nor makes a second one:
 * the next submit only links it. The keys are kept for the same reason (a retry replays, never repeats).
 */
export interface OrderDraft {
  readonly description: string;
  readonly setDescription: (value: string) => void;
  /** The id of the order already registered for this draft, `null` before it exists. */
  readonly created: string | null;
  readonly setCreated: (orderId: string) => void;
  readonly keys: React.RefObject<SubmitKeys>;
  /** Starts over once the order is linked. */
  readonly reset: () => void;
}

export function useOrderDraft(incident: BffIncident): OrderDraft {
  const [description, setDescription] = React.useState(() => defaultOrderDescription(incident));
  const [created, setCreated] = React.useState<string | null>(null);
  const keys = React.useRef(new SubmitKeys());
  const reset = React.useCallback(() => {
    setDescription(defaultOrderDescription(incident));
    setCreated(null);
    keys.current = new SubmitKeys();
  }, [incident]);
  return { description, setDescription, created, setCreated, keys, reset };
}
