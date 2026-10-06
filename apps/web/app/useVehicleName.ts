import React from 'react';
import { useSession } from '../auth/session';

/**
 * The economic number of a vehicle, for screens that show what a document or a policy belongs to. Best effort: it is
 * `null` while loading and when the vehicle cannot be read (the screen then falls back to a generic label).
 */
export function useVehicleName(vehicleId: string | null): string | null {
  const { ports } = useSession();
  const [name, setName] = React.useState<string | null>(null);
  React.useEffect(() => {
    setName(null);
    if (vehicleId === null) return undefined;
    let cancelled = false;
    void ports.vehicles.get(vehicleId).then((result) => {
      if (!cancelled && result.ok) setName(result.value.economicNumber);
    });
    return () => {
      cancelled = true;
    };
  }, [ports, vehicleId]);
  return name;
}
