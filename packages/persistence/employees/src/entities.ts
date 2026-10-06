import { EntitySchema } from 'typeorm';

/**
 * Key-like and text columns use a binary NO PAD collation: keys are compared exactly as normalized
 * by the domain, never folded again by the server.
 */
export const BINARY_COLLATION = 'utf8mb4_0900_bin';

export const EMPLOYEE_TABLES = {
  employees: 'opslog_employees',
  history: 'opslog_employee_history',
} as const;

/**
 * Employee row. `tenantId` is the BRD's `company_id`: part of the primary key and of every unique
 * key, so no query can reach a row without naming its company.
 *
 * Personal data (D23) is stored only as `pii1.` envelopes in the `*_enc` columns plus HMAC blind
 * indexes in the `*_idx` columns; there is no column that could hold a plaintext value.
 */
export class EmployeeEntity {
  tenantId!: string;
  id!: string;
  kind!: string;
  firstName!: string;
  lastName!: string;
  /** Ordering key: last name then first name, case-folded. */
  nameKey!: string;
  employeeNumber!: string | null;
  /** Case-folded uniqueness key of `employeeNumber`. */
  employeeNumberKey!: string | null;
  position!: string | null;
  hireDate!: string | null;
  areaId!: string;
  status!: string;
  statusReason!: string;
  idType!: string | null;
  nationalIdEnc!: string | null;
  nationalIdIdx!: string | null;
  phoneEnc!: string | null;
  emailEnc!: string | null;
  emailIdx!: string | null;
  licenseNumberEnc!: string | null;
  licenseNumberIdx!: string | null;
  licenseType!: string | null;
  licenseExpiresOn!: string | null;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
  archivedAt!: Date | null;
}

export class EmployeeHistoryEntity {
  tenantId!: string;
  id!: string;
  employeeId!: string;
  kind!: string;
  fromValue!: string | null;
  toValue!: string;
  reason!: string | null;
  actorId!: string;
  version!: number;
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

/** Longest envelope a column holds (`pii1.` + key id + wrapped key + iv + ciphertext and tag, base64url). */
export const SEALED_LENGTH = 1024;

export const EmployeeEntitySchema = new EntitySchema<EmployeeEntity>({
  name: 'EmployeeEntity',
  target: EmployeeEntity,
  tableName: EMPLOYEE_TABLES.employees,
  columns: {
    tenantId: { name: 'company_id', type: 'varchar', length: 64, collation: bin, primary: true },
    id: { type: 'varchar', length: 64, collation: bin, primary: true },
    kind: text('kind', 16),
    firstName: text('first_name', 60),
    lastName: text('last_name', 60),
    nameKey: text('name_key', 121),
    employeeNumber: text('employee_number', 32, true),
    employeeNumberKey: text('employee_number_key', 32, true),
    position: text('position', 60, true),
    hireDate: fixed('hire_date', 10, true),
    areaId: text('area_id', 64),
    status: text('status', 16),
    statusReason: text('status_reason', 200),
    idType: text('id_type', 16, true),
    nationalIdEnc: text('national_id_enc', SEALED_LENGTH, true),
    nationalIdIdx: fixed('national_id_idx', 64, true),
    phoneEnc: text('phone_enc', SEALED_LENGTH, true),
    emailEnc: text('email_enc', SEALED_LENGTH, true),
    emailIdx: fixed('email_idx', 64, true),
    licenseNumberEnc: text('license_number_enc', SEALED_LENGTH, true),
    licenseNumberIdx: fixed('license_number_idx', 64, true),
    licenseType: text('license_type', 16, true),
    licenseExpiresOn: fixed('license_expires_on', 10, true),
    version: { type: 'int', unsigned: true },
    createdAt: { name: 'created_at', type: 'datetime', precision: 6 },
    updatedAt: { name: 'updated_at', type: 'datetime', precision: 6 },
    archivedAt: { name: 'archived_at', type: 'datetime', precision: 6, nullable: true },
  },
  uniques: [
    { name: 'uq_employees_number', columns: ['tenantId', 'employeeNumberKey'] },
    { name: 'uq_employees_national_id', columns: ['tenantId', 'nationalIdIdx'] },
    { name: 'uq_employees_email', columns: ['tenantId', 'emailIdx'] },
  ],
  indices: [
    { name: 'ix_employees_status', columns: ['tenantId', 'status'] },
    { name: 'ix_employees_area', columns: ['tenantId', 'areaId'] },
    { name: 'ix_employees_license', columns: ['tenantId', 'licenseNumberIdx'] },
    { name: 'ix_employees_listing', columns: ['tenantId', 'nameKey', 'id'] },
  ],
});

export const EmployeeHistoryEntitySchema = new EntitySchema<EmployeeHistoryEntity>({
  name: 'EmployeeHistoryEntity',
  target: EmployeeHistoryEntity,
  tableName: EMPLOYEE_TABLES.history,
  columns: {
    tenantId: { name: 'company_id', type: 'varchar', length: 64, collation: bin, primary: true },
    id: { type: 'varchar', length: 64, collation: bin, primary: true },
    employeeId: text('employee_id', 64),
    kind: text('kind', 8),
    fromValue: text('from_value', 64, true),
    toValue: text('to_value', 64),
    reason: text('reason', 200, true),
    actorId: text('actor_id', 64),
    version: { type: 'int', unsigned: true },
    at: { type: 'datetime', precision: 6 },
  },
  uniques: [
    { name: 'uq_employee_history_version', columns: ['tenantId', 'employeeId', 'version'] },
  ],
});

export const EMPLOYEE_ENTITIES = [EmployeeEntitySchema, EmployeeHistoryEntitySchema] as const;
