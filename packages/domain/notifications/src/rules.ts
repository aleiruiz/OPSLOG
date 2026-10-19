import { EVENT_KINDS, KINDS, isEventKind, type EventKind } from './catalog.js';
import { NotificationError } from './errors.js';
import type { CompanyRule } from './types.js';

/** Until the company decides otherwise: every kind this module e-mails may be e-mailed, with no quiet hours. */
export function defaultRule(): CompanyRule {
  return {
    emailKinds: EVENT_KINDS.filter((kind) => KINDS[kind].email),
    quietHours: false,
    updatedAt: null,
  };
}

/** The kinds a company rule may list: only those this module e-mails. */
export function parseEmailKinds(value: unknown): readonly EventKind[] {
  if (!Array.isArray(value) || value.length > EVENT_KINDS.length)
    throw new NotificationError('invalid_input', 'emailKinds');
  const kinds = new Set<EventKind>();
  for (const item of value) {
    if (!isEventKind(item) || !KINDS[item].email)
      throw new NotificationError('invalid_input', 'emailKinds');
    kinds.add(item);
  }
  return EVENT_KINDS.filter((kind) => kinds.has(kind));
}
