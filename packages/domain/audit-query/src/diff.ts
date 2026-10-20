import type { AuditChange, AuditViewer, ChangeRecord, ChangeScalar } from './types.js';

/**
 * How a field may be shown (ADR-0016 question 1). `none`: structured value, shown when the module history
 * kept it. `ref`: an opaque id, only the fact of the change. `pii` and `costs`: shown only with that
 * permission. `text`: free text can carry names or contact data, so its value is never sent.
 */
type Sensitivity = 'none' | 'ref' | 'pii' | 'costs' | 'text';
interface FieldPolicy {
  readonly label: string;
  readonly sensitivity: Sensitivity;
  /** Permission that lifts a `pii` or `costs` restriction. */
  readonly permission?: string;
}

const INCIDENT_FIELDS: Readonly<Record<string, FieldPolicy>> = {
  status: { label: 'Estado', sensitivity: 'none' },
  type: { label: 'Tipo', sensitivity: 'none' },
  severity: { label: 'Gravedad', sensitivity: 'none' },
  occurredAt: { label: 'Fecha del evento', sensitivity: 'none' },
  vehicleOperable: { label: 'Vehículo operable', sensitivity: 'none' },
  coverageStatus: { label: 'Cobertura', sensitivity: 'none' },
  vehicleId: { label: 'Vehículo', sensitivity: 'ref' },
  policyId: { label: 'Póliza', sensitivity: 'ref' },
  policyRevision: { label: 'Revisión de la póliza', sensitivity: 'none' },
  driverId: { label: 'Conductor', sensitivity: 'pii', permission: 'view_pii' },
  noDriverReason: { label: 'Motivo sin conductor', sensitivity: 'text' },
  location: { label: 'Ubicación', sensitivity: 'text' },
  description: { label: 'Descripción', sensitivity: 'text' },
  damage: { label: 'Daños', sensitivity: 'text' },
  noPhotoJustification: { label: 'Justificación sin foto', sensitivity: 'text' },
  costs: { label: 'Costos', sensitivity: 'costs', permission: 'incidents:view_costs' },
  repairs: { label: 'Reparaciones', sensitivity: 'ref' },
  thirdParties: { label: 'Terceros', sensitivity: 'pii', permission: 'view_pii' },
  evidence: { label: 'Evidencia', sensitivity: 'ref' },
};

const WORK_ORDER_FIELDS: Readonly<Record<string, FieldPolicy>> = {
  status: { label: 'Estado', sensitivity: 'none' },
  costs: { label: 'Costos', sensitivity: 'costs', permission: 'view_costs' },
};

const POLICIES: Readonly<Record<string, Readonly<Record<string, FieldPolicy>>>> = {
  incident: INCIDENT_FIELDS,
  maintenance_work_order: WORK_ORDER_FIELDS,
};

/** Entity types whose module history this package can show field by field. */
export const DIFF_ENTITY_TYPES: readonly string[] = Object.keys(POLICIES);

const UNKNOWN_FIELD: FieldPolicy = { label: 'Otro campo', sensitivity: 'text' };

function mayLift(policy: FieldPolicy, viewer: AuditViewer): boolean {
  return policy.permission !== undefined && viewer.permissions.includes(policy.permission);
}

const has = (value: ChangeScalar | undefined): value is ChangeScalar => value !== undefined;

/** One changed field, as much as the caller may see of it. Restricted values never enter the result. */
function showField(
  policy: FieldPolicy,
  field: { readonly name: string; readonly before?: ChangeScalar; readonly after?: ChangeScalar },
  viewer: AuditViewer,
): AuditChange {
  const base = { field: field.name, label: policy.label };
  if (policy.sensitivity === 'text') return { ...base, state: 'restricted' };
  if (policy.sensitivity === 'ref') return { ...base, state: 'not_recorded' };
  if ((policy.sensitivity === 'pii' || policy.sensitivity === 'costs') && !mayLift(policy, viewer))
    return { ...base, state: 'restricted' };
  if (!has(field.before) && !has(field.after)) return { ...base, state: 'not_recorded' };
  return {
    ...base,
    state: 'value',
    ...(has(field.before) ? { before: field.before } : {}),
    ...(has(field.after) ? { after: field.after } : {}),
  };
}

/** The change of a module history that an audit event recorded, as the caller may see it. */
export function describeChange(
  entityType: string,
  record: ChangeRecord,
  viewer: AuditViewer,
): readonly AuditChange[] {
  const policies = POLICIES[entityType] ?? {};
  return record.fields.map((field) =>
    showField(policies[field.name] ?? UNKNOWN_FIELD, field, viewer),
  );
}

/** History commands that an audit action names directly; any other action refers to a state command. */
const COMMAND_OF_VERB: Readonly<Record<string, string>> = {
  created: 'create',
  updated: 'update',
  coverage_none: 'coverage_none',
};
const NAMED_COMMANDS: readonly string[] = Object.values(COMMAND_OF_VERB);

/**
 * Picks the history record an audit event refers to: the one at the same instant that the action names
 * (`created`, `updated`, `coverage_none`) or, for the other actions, the state command. A case that also became
 * uncovered writes several records at one instant; each event takes its own.
 */
export function recordOfEvent(
  action: string,
  occurredAt: string,
  records: readonly ChangeRecord[],
): ChangeRecord | null {
  const at = Date.parse(occurredAt);
  const sameInstant = records.filter((record) => Date.parse(record.occurredAt) === at);
  const expected = COMMAND_OF_VERB[action.slice(action.lastIndexOf('.') + 1)];
  const matched = sameInstant.find((record) =>
    expected === undefined ? !NAMED_COMMANDS.includes(record.command) : record.command === expected,
  );
  return matched ?? null;
}
