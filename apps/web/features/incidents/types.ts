import type { BffIncident, BffVehicleStatus } from '@opslog/contracts';

/** A state command of SPECS §6.2 (the contract module does not re-export the union). */
export type IncidentCommand = BffIncident['allowedCommands'][number];
export type Approval = NonNullable<BffIncident['resolution']['closeApproval']>;
export type InsurerResult = NonNullable<BffIncident['insurance']['insurerResult']>;
/** The vehicle states a resolution may record (D11): the same set the vehicles module uses. */
export type VehicleDecision = BffVehicleStatus;
/** A case with its fields writable, for the stand-in server that builds one step by step. */
export type Writable<T> = { -readonly [K in keyof T]?: T[K] };

export const INCIDENT_COMMANDS: readonly IncidentCommand[] = [
  'report',
  'assign',
  'review',
  'insure',
  'no_insurance',
  'reject',
  'appeal',
  'approve_assumption',
  'repair',
  'resolve',
  'approve_close',
  'close',
  'reopen',
  'cancel',
];
