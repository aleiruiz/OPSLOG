import React from 'react';
import type { BffCloseCostThreshold, BffIncident } from '@opslog/contracts';
import type { DirectoryOption } from '../maintenance/directory';
import type { ViewsPorts } from '../search/views/ports';
import type { IncidentPorts } from './ports';

/**
 * Pieces of other M5 modules that the case mounts (follow, report links, audit history). The shell supplies
 * them, because they read the session; without them the case simply does not show those entries.
 */
export interface IncidentExtras {
  /** Header actions of the case: «Seguir» and the link to its PDF sheet. */
  readonly actions?: (incident: BffIncident) => React.ReactNode;
  /** Content of the «Historial» tab; the tab exists only when this is set and the caller holds `view_audit`. */
  readonly history?: (incidentId: string) => React.ReactNode;
}

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
  /** Saved views and persistent columns of the case list; without them the list only keeps its filters in the address. */
  readonly views?: ViewsPorts | undefined;
  readonly extras?: IncidentExtras | undefined;
}

const EnvContext = React.createContext<IncidentEnv | null>(null);
export const IncidentEnvProvider = EnvContext.Provider;

export function useIncidentEnv(): IncidentEnv {
  const value = React.useContext(EnvContext);
  if (!value) throw new Error('useIncidentEnv requires an IncidentEnvProvider');
  return value;
}
