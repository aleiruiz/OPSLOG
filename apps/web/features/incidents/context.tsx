import React from 'react';
import type { BffCloseCostThreshold } from '@opslog/contracts';
import type { DirectoryOption } from '../maintenance/directory';
import type { IncidentPorts } from './ports';

/** What every incident screen needs from the shell: the ports, who the caller is and the company's zone. */
export interface IncidentEnv {
  readonly ports: IncidentPorts;
  readonly permissions: readonly string[];
  readonly userId: string;
  /** IANA zone of the company: dates are shown and typed in it. */
  readonly zone: string;
  /** People who can be made responsible, the caller first. Empty names are never shown as ids. */
  readonly members: readonly DirectoryOption[];
  /** Drivers of the company by name, for choices beyond the suggestions (empty when they could not be loaded). */
  readonly drivers: readonly DirectoryOption[];
  /** The caller may change a vehicle's status (generic `edit` of the vehicles module). */
  readonly mayChangeVehicles: boolean;
  /** The company's photo rule at report time, when the settings could be read. */
  readonly photoRequired: boolean;
  /**
   * The D20 threshold, for display next to the costs. Only read for callers with `incidents:view_costs`; it is
   * `null` for everyone else, so no amount reaches a screen that must not show one. Never compared on the client.
   */
  readonly approvalThreshold: BffCloseCostThreshold | null;
  readonly onExpired: () => void;
}

const EnvContext = React.createContext<IncidentEnv | null>(null);
export const IncidentEnvProvider = EnvContext.Provider;

export function useIncidentEnv(): IncidentEnv {
  const value = React.useContext(EnvContext);
  if (!value) throw new Error('useIncidentEnv requires an IncidentEnvProvider');
  return value;
}
