import { PolicyError } from './errors.js';
import {
  type NewPolicyData,
  type Policy,
  type PolicyPatch,
  type PolicyRevision,
  type PolicyRevisionData,
} from './types.js';

/** Whether the policy covers `day` (`startsOn` and `endsOn` are both inclusive). BR-019 / FR-111. */
export const coversOn = (
  policy: Pick<PolicyRevisionData, 'startsOn' | 'endsOn'>,
  day: string,
): boolean => policy.startsOn <= day && day <= policy.endsOn;

/** Archived policies are read-only. */
function assertEditable(policy: Policy): void {
  if (policy.archivedAt !== null) throw new PolicyError('immutable');
}

function assertVersion(policy: Policy, expectedVersion: number): void {
  if (policy.version !== expectedVersion) throw new PolicyError('stale_version');
}

const touched = (policy: Policy, now: Date): Pick<Policy, 'version' | 'updatedAt'> => ({
  version: policy.version + 1,
  updatedAt: now.toISOString(),
});

export const revisionDataOf = (policy: Policy): PolicyRevisionData => ({
  policyNumber: policy.policyNumber,
  coverageType: policy.coverageType,
  startsOn: policy.startsOn,
  endsOn: policy.endsOn,
  deductible: policy.deductible,
});

export function revisionOf(policy: Policy, actorId: string, now: Date): PolicyRevision {
  return {
    tenantId: policy.tenantId,
    policyId: policy.id,
    revision: policy.revision,
    ...revisionDataOf(policy),
    actorId,
    at: now.toISOString(),
  };
}

/** The first record of a policy: revision 1, version 1, not archived. */
export function newPolicy(tenantId: string, id: string, data: NewPolicyData, now: Date): Policy {
  return {
    id,
    tenantId,
    vehicleId: data.vehicleId,
    insurer: data.insurer,
    coverageNotes: data.coverageNotes,
    revision: 1,
    ...data.revision,
    version: 1,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    archivedAt: null,
  };
}

export function applyPatch(
  policy: Policy,
  patch: PolicyPatch,
  expectedVersion: number,
  now: Date,
): Policy {
  assertEditable(policy);
  assertVersion(policy, expectedVersion);
  return { ...policy, ...patch, ...touched(policy, now) };
}

/** BR-025 / US-012: a renewal is a new revision; the previous one stays in the history untouched. */
export function applyRenewal(
  policy: Policy,
  data: PolicyRevisionData,
  expectedVersion: number,
  now: Date,
): Policy {
  assertEditable(policy);
  assertVersion(policy, expectedVersion);
  return { ...policy, ...data, revision: policy.revision + 1, ...touched(policy, now) };
}

/** Soft delete (BR-009): the row and its revisions stay, hidden from default listings and read-only. */
export function applyArchive(policy: Policy, expectedVersion: number, now: Date): Policy {
  assertEditable(policy);
  assertVersion(policy, expectedVersion);
  return { ...policy, archivedAt: now.toISOString(), ...touched(policy, now) };
}
