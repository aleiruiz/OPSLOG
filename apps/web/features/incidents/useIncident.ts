import type { BffIncident, BffIncidentSuggestions } from '@opslog/contracts';
import { useIncidentEnv } from './env';
import { useLive, type Live } from './useLive';

/** A newer answer replaces what is shown; an older one that arrives late (a slow refresh) never does. */
const notOlder = (next: BffIncident, shown: BffIncident | null): boolean =>
  shown === null || next.version >= shown.version;

/** The case, refreshed in place: forms and tabs stay mounted (and keep unsent text) while it reloads. */
export function useIncident(id: string): Live<BffIncident> {
  const env = useIncidentEnv();
  return useLive(() => env.ports.get(id), [env.ports, id], env.onExpired, notOlder);
}

/**
 * Drivers and policies that fit the vehicle at the event instant. Needs an instant; without one, or when the
 * caller may not ask, there are simply no suggestions (the forms still work with manual choices).
 */
export function useSuggestions(
  vehicleId: string | null,
  occurredAt: string | null,
): BffIncidentSuggestions | null {
  const env = useIncidentEnv();
  const live = useLive(
    async () =>
      vehicleId !== null && occurredAt !== null
        ? env.ports.suggestions({ vehicleId, occurredAt })
        : {
            ok: false as const,
            error: { status: 400 as const, code: 'bad_request', message: '', correlationId: '' },
          },
    [env.ports, vehicleId, occurredAt],
    env.onExpired,
  );
  return vehicleId !== null && occurredAt !== null ? live.data : null;
}
