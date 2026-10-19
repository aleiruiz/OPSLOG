import React from 'react';
import { useSession } from '../../auth/session';
import { DEFAULT_ZONE } from '../incidents/time';

/** The company's time zone (dates are shown in it, SPECS §2.3); UTC until the settings are read. */
export function useCompanyZone(): string {
  const { ports, state } = useSession();
  const [zone, setZone] = React.useState(DEFAULT_ZONE);
  const authenticated = state.status === 'authenticated';
  React.useEffect(() => {
    if (!authenticated) return undefined;
    let current = true;
    void ports.alerts.settings().then((result) => {
      if (current && result.ok) setZone(result.value.timeZone);
    });
    return () => {
      current = false;
    };
  }, [ports, authenticated]);
  return zone;
}
