import { EntitySchema } from 'typeorm';

/**
 * Key-like and text columns use a binary NO PAD collation: keys are compared exactly as normalized
 * by the domain, never folded again by the server.
 */
export const BINARY_COLLATION = 'utf8mb4_0900_bin';

export const POLICY_TABLES = {
  policies: 'opslog_insurance_policies',
  revisions: 'opslog_insurance_policy_revisions',
} as const;

/**
 * Policy row. `tenantId` is the BRD's `company_id`: part of the primary key and of every index,
 * so no query can reach a row without naming its company. The period and the deductible are a copy
 * of the current revision. The deductible is three typed columns (kind, value, currency) that a
 * CHECK keeps consistent: an amount is a whole number of minor units with an ISO currency, a
 * percentage is whole basis points without currency. `deductibleValue` is a BIGINT, which the
 * driver returns as a string; the store converts it.
 */
export class PolicyEntity {
  tenantId!: string;
  id!: string;
  vehicleId!: string;
  insurer!: string;
  coverageNotes!: string | null;
  revision!: number;
  policyNumber!: string;
  coverageType!: string;
  startsOn!: string;
  endsOn!: string;
  deductibleKind!: string | null;
  deductibleValue!: number | string | null;
  deductibleCurrency!: string | null;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
  archivedAt!: Date | null;
}

/** Immutable snapshot of one revision: written once, never updated. */
export class PolicyRevisionEntity {
  tenantId!: string;
  policyId!: string;
  revision!: number;
  policyNumber!: string;
  coverageType!: string;
  startsOn!: string;
  endsOn!: string;
  deductibleKind!: string | null;
  deductibleValue!: number | string | null;
  deductibleCurrency!: string | null;
  actorId!: string;
  at!: Date;
}

const bin = BINARY_COLLATION;
const text = (name: string, length: number, nullable = false) => ({
  name,
  type: 'varchar' as const,
  length,
  collation: bin,
  ...(nullable ? { nullable: true } : {}),
});
const fixed = (name: string, length: number, nullable = false) => ({
  name,
  type: 'char' as const,
  length,
  collation: bin,
  ...(nullable ? { nullable: true } : {}),
});
const deductibleKind = text('deductible_kind', 8, true);
const deductibleValue = {
  name: 'deductible_value',
  type: 'bigint' as const,
  unsigned: true,
  nullable: true,
};
const deductibleCurrency = fixed('deductible_currency', 3, true);

export const PolicyEntitySchema = new EntitySchema<PolicyEntity>({
  name: 'PolicyEntity',
  target: PolicyEntity,
  tableName: POLICY_TABLES.policies,
  columns: {
    tenantId: { name: 'company_id', type: 'varchar', length: 64, collation: bin, primary: true },
    id: { type: 'varchar', length: 64, collation: bin, primary: true },
    vehicleId: text('vehicle_id', 64),
    insurer: text('insurer', 80),
    coverageNotes: text('coverage_notes', 500, true),
    revision: { type: 'int', unsigned: true },
    policyNumber: text('policy_number', 40),
    coverageType: text('coverage_type', 24),
    startsOn: fixed('starts_on', 10),
    endsOn: fixed('ends_on', 10),
    deductibleKind,
    deductibleValue,
    deductibleCurrency,
    version: { type: 'int', unsigned: true },
    createdAt: { name: 'created_at', type: 'datetime', precision: 6 },
    updatedAt: { name: 'updated_at', type: 'datetime', precision: 6 },
    archivedAt: { name: 'archived_at', type: 'datetime', precision: 6, nullable: true },
  },
  indices: [
    { name: 'ix_policies_vehicle', columns: ['tenantId', 'vehicleId'] },
    { name: 'ix_policies_coverage', columns: ['tenantId', 'coverageType'] },
    { name: 'ix_policies_listing', columns: ['tenantId', 'endsOn', 'id'] },
  ],
});

export const PolicyRevisionEntitySchema = new EntitySchema<PolicyRevisionEntity>({
  name: 'PolicyRevisionEntity',
  target: PolicyRevisionEntity,
  tableName: POLICY_TABLES.revisions,
  columns: {
    tenantId: { name: 'company_id', type: 'varchar', length: 64, collation: bin, primary: true },
    policyId: { ...text('policy_id', 64), primary: true },
    revision: { type: 'int', unsigned: true, primary: true },
    policyNumber: text('policy_number', 40),
    coverageType: text('coverage_type', 24),
    startsOn: fixed('starts_on', 10),
    endsOn: fixed('ends_on', 10),
    deductibleKind,
    deductibleValue,
    deductibleCurrency,
    actorId: text('actor_id', 64),
    at: { type: 'datetime', precision: 6 },
  },
});

export const POLICY_ENTITIES = [PolicyEntitySchema, PolicyRevisionEntitySchema] as const;
