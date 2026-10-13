import {
  INCIDENT_COMMANDS,
  INSURER_RESULTS,
  type IncidentCommand,
  type InsurerResult,
} from '../../cases/src/index.js';
import {
  Issues,
  booleanField,
  enumField,
  idField,
  isValidDay,
  objectOf,
  present,
  textField,
  versionField,
} from '../../cases/src/validation.js';
import type { CommandInput } from './requirements.js';

/** Longest text of each field; they fit the columns of the incident and of the timeline. */
export const WORKFLOW_LIMITS = {
  comment: 1000,
  reason: 1000,
  insurerName: 200,
  claimNumber: 100,
  adjusterName: 200,
  adjusterContact: 200,
  rejectionReason: 1000,
  appealNote: 1000,
  noInsuranceReason: 1000,
  resolutionSummary: 2000,
} as const;

/** What a screen may record as the state of the vehicle after the case (D11): recorded, never applied. */
export const VEHICLE_STATUS_DECISIONS = [
  'active',
  'restricted',
  'in_maintenance',
  'out_of_service',
  'inactive',
  'decommissioned',
] as const;
export type VehicleStatusDecision = (typeof VEHICLE_STATUS_DECISIONS)[number];

export interface ParsedCommand extends CommandInput {
  readonly command: IncidentCommand;
  readonly version: number;
  readonly comment: string | null;
}

/** Fields beyond `command`, `version` and `comment` that a command takes in its body. */
const EXTRA_KEYS: Readonly<Partial<Record<IncidentCommand, readonly string[]>>> = {
  assign: ['responsibleId'],
  cancel: ['reason'],
  reopen: ['reason'],
};

/** A blank text is an absent one: the missing list names it, instead of a 400 about its format. */
function optionalText(issues: Issues, field: string, value: unknown, max: number): string | null {
  if (value === undefined || (typeof value === 'string' && value.trim().length === 0)) return null;
  return textField(issues, field, value, max, false) ?? null;
}

/** The body of `POST /transitions`: the command, the version it was decided at and its own fields. */
export function parseCommand(input: unknown): ParsedCommand {
  const issues = new Issues();
  const data = objectOf(
    input,
    ['command', 'version', 'comment', 'reason', 'responsibleId'],
    issues,
  );
  const command = present(data, 'command')
    ? enumField(issues, 'command', data['command'], INCIDENT_COMMANDS)
    : issues.add('command', 'required');
  if (!present(data, 'version')) issues.add('version', 'required');
  const version = present(data, 'version') ? versionField(issues, data['version']) : undefined;
  // A field that belongs to another command is a mistake of the caller, not something to ignore.
  const allowed = command ? (EXTRA_KEYS[command] ?? []) : ['responsibleId', 'reason'];
  for (const key of ['responsibleId', 'reason'])
    if (present(data, key) && !allowed.includes(key)) issues.add(key, 'unknown_property');
  const responsibleId = present(data, 'responsibleId')
    ? idField(issues, 'responsibleId', data['responsibleId'])
    : null;
  const reason = optionalText(issues, 'reason', data['reason'], WORKFLOW_LIMITS.reason);
  const comment = optionalText(issues, 'comment', data['comment'], WORKFLOW_LIMITS.comment);
  issues.throwIfAny();
  return {
    command: command as IncidentCommand,
    version: version as number,
    comment,
    reason,
    responsibleId: responsibleId ?? null,
  };
}

export interface InsuranceChanges {
  readonly version: number;
  readonly policyId?: string | null;
  readonly insurerName?: string | null;
  readonly claimNumber?: string | null;
  readonly adjusterName?: string | null;
  readonly adjusterContact?: string | null;
  readonly insurerReportedOn?: string | null;
  readonly insurerResult?: InsurerResult | null;
  readonly rejectionReason?: string | null;
  readonly appealNote?: string | null;
  readonly noInsuranceReason?: string | null;
}
export interface ResolutionChanges {
  readonly version: number;
  readonly resolutionSummary?: string | null;
  readonly totalLoss?: boolean | null;
  readonly vehicleStatusDecision?: VehicleStatusDecision | null;
  readonly costAssumed?: boolean | null;
}

const INSURANCE_TEXT = [
  'insurerName',
  'claimNumber',
  'adjusterName',
  'adjusterContact',
  'rejectionReason',
  'appealNote',
  'noInsuranceReason',
] as const;

type Take = (key: string, parse: (value: unknown) => unknown) => void;

/** Parses a partial update: a field that is absent stays, `null` clears it. Names of bad fields only. */
function parseData<T extends { version: number }>(
  input: unknown,
  keys: readonly string[],
  read: (take: Take, issues: Issues) => void,
): T {
  const issues = new Issues();
  const data = objectOf(input, ['version', ...keys], issues);
  if (!present(data, 'version')) issues.add('version', 'required');
  const version = present(data, 'version') ? versionField(issues, data['version']) : undefined;
  const out: Record<string, unknown> = {};
  read((key, parse) => {
    if (!present(data, key)) return;
    const parsed = parse(data[key]);
    if (parsed !== undefined) out[key] = parsed;
  }, issues);
  if (!issues.any && Object.keys(out).length === 0) issues.add('body', 'required');
  issues.throwIfAny();
  return { version: version as number, ...out } as T;
}

export function parseInsurance(input: unknown): InsuranceChanges {
  return parseData<InsuranceChanges>(
    input,
    ['policyId', 'insurerReportedOn', 'insurerResult', ...INSURANCE_TEXT],
    (take, issues) => {
      take('policyId', (v) => idField(issues, 'policyId', v, true));
      take('insurerResult', (v) => enumField(issues, 'insurerResult', v, INSURER_RESULTS, true));
      take('insurerReportedOn', (v) =>
        v === null ? null : isValidDay(v) ? v : issues.add('insurerReportedOn', 'invalid'),
      );
      for (const key of INSURANCE_TEXT)
        take(key, (v) => textField(issues, key, v, WORKFLOW_LIMITS[key]));
    },
  );
}

export function parseResolution(input: unknown): ResolutionChanges {
  return parseData<ResolutionChanges>(
    input,
    ['resolutionSummary', 'totalLoss', 'vehicleStatusDecision', 'costAssumed'],
    (take, issues) => {
      take('resolutionSummary', (v) =>
        textField(issues, 'resolutionSummary', v, WORKFLOW_LIMITS.resolutionSummary),
      );
      take('totalLoss', (v) => booleanField(issues, 'totalLoss', v));
      take('costAssumed', (v) => booleanField(issues, 'costAssumed', v));
      take('vehicleStatusDecision', (v) =>
        enumField(issues, 'vehicleStatusDecision', v, VEHICLE_STATUS_DECISIONS, true),
      );
    },
  );
}
