import { randomUUID } from 'node:crypto';
import type { PiiCipher } from '../../../platform/pii/src/index.js';
import {
  DEFAULT_LIST_LIMIT,
  INDEXED_FIELDS,
  MAX_LIST_LIMIT,
  PII_FIELD_LABEL,
  PII_INPUT_KEYS,
  isEmployeeKind,
  isEmployeeStatus,
} from './types.js';
import type {
  Employee,
  EmployeeHistoryEntry,
  EmployeePii,
  EmployeePiiValues,
  PiiField,
  SealedField,
} from './types.js';
import { EmployeeError } from './errors.js';
import {
  dateOf,
  invalid,
  isInteger,
  licenseNumberKey,
  nationalIdKey,
  normalizeReason,
  requireOpaqueId,
  requireVersion,
} from './validation.js';
import { LICENSE_KEYS, parseEmployeePatch, parseNewEmployee } from './parsing.js';
import type { PiiInput } from './parsing.js';
import {
  applyArchive,
  applyPatch,
  applyStatus,
  areaEntry,
  fitnessOf,
  newEmployee,
  statusEntry,
} from './rules.js';
import type { Fitness } from './rules.js';
import type {
  EmployeeFilter,
  EmployeeHistorySlice,
  EmployeeSlice,
  EmployeeStore,
  EmployeeWindow,
} from './store.js';

/**
 * Port to the Areas module (BR-021). `withActiveArea` runs `work` only while `areaId` is an ACTIVE
 * area of `tenantId` and cannot be deactivated: the implementation holds the same per-tenant
 * serialization the area deactivation runs under for the whole duration of `work`, so a
 * deactivation cannot commit between the check and the employee write. Unknown, foreign and
 * inactive areas are indistinguishable: it throws `EmployeeError('invalid_area', 'area_id')`
 * without running `work`. Errors of `work` propagate unchanged.
 */
export interface EmployeeAreaGate {
  withActiveArea<T>(tenantId: string, areaId: string, work: () => Promise<T>): Promise<T>;
}

export interface EmployeeListQuery {
  readonly kind?: unknown;
  readonly status?: unknown;
  readonly areaId?: unknown;
  readonly includeArchived?: unknown;
  readonly limit?: unknown;
  readonly offset?: unknown;
}

export interface EmployeeHistoryQuery {
  readonly limit?: unknown;
  readonly offset?: unknown;
}

export interface EmployeeServiceOptions {
  /** Encrypts PII at rest and computes blind indexes. Required: nothing is ever stored in the clear. */
  readonly pii: PiiCipher;
  /**
   * Validates and serializes writes that set or change `areaId`. Without it the area is not
   * checked (only for tests of this package); the platform composition always supplies it.
   */
  readonly areas?: EmployeeAreaGate;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

function windowOf(query: EmployeeHistoryQuery): EmployeeWindow {
  const limit = query.limit === undefined ? DEFAULT_LIST_LIMIT : query.limit;
  const offset = query.offset === undefined ? 0 : query.offset;
  if (!isInteger(limit, 1, MAX_LIST_LIMIT) || !isInteger(offset, 0, 1_000_000)) return invalid();
  return { limit, offset };
}

const ENTITY = 'employee';

/**
 * Employee use cases over the store port. Authorization, authentication and audit belong to the
 * caller (the composition); this class enforces the domain rules and is the only place that
 * seals and opens personal data. The tenant is always an argument taken from the server-side
 * session, never part of the input being validated.
 */
export class EmployeeService {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly areas: EmployeeAreaGate | undefined;
  private readonly pii: PiiCipher;

  public constructor(
    private readonly store: EmployeeStore,
    options: EmployeeServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
    this.areas = options.areas;
    this.pii = options.pii;
  }

  /** Runs a write that sets `areaId` under the area gate (a no-op wrapper without one). */
  private inArea<T>(tenantId: string, areaId: string, work: () => Promise<T>): Promise<T> {
    return this.areas ? this.areas.withActiveArea(tenantId, areaId, work) : work();
  }

  private async seal(
    tenantId: string,
    id: string,
    field: PiiField,
    plaintext: string,
    indexKey: string | null,
  ): Promise<SealedField> {
    const label = PII_FIELD_LABEL[field];
    const sealed = await this.pii.seal(
      { tenantId, entityType: ENTITY, entityId: id, field: label },
      plaintext,
    );
    const index =
      indexKey !== null && INDEXED_FIELDS.includes(field)
        ? await this.pii.blindIndex(tenantId, label, indexKey)
        : null;
    return { sealed, index };
  }

  /** Seals every present field of `input`; `null` clears. Returns only the fields that were present. */
  private async sealAll(
    tenantId: string,
    id: string,
    input: PiiInput,
  ): Promise<{ pii: Partial<EmployeePii>; idType: string | null | undefined }> {
    const pii: { -readonly [K in PiiField]?: SealedField | null } = {};
    let idType: string | null | undefined;
    if (input.nationalId !== undefined) {
      idType = input.nationalId === null ? null : input.nationalId.idType;
      pii.nationalId =
        input.nationalId === null
          ? null
          : await this.seal(
              tenantId,
              id,
              'nationalId',
              input.nationalId.value,
              nationalIdKey(input.nationalId.idType, input.nationalId.value),
            );
    }
    if (input.phone !== undefined)
      pii.phone =
        input.phone === null ? null : await this.seal(tenantId, id, 'phone', input.phone, null);
    if (input.email !== undefined)
      pii.email =
        input.email === null
          ? null
          : await this.seal(tenantId, id, 'email', input.email, input.email);
    if (input.licenseNumber !== undefined)
      pii.licenseNumber =
        input.licenseNumber === null
          ? null
          : await this.seal(
              tenantId,
              id,
              'licenseNumber',
              input.licenseNumber,
              licenseNumberKey(input.licenseNumber),
            );
    return { pii, idType };
  }

  /** The employee of this tenant, or `not_found` (also for ids of other tenants). */
  private async load(tenantId: string, id: unknown): Promise<Employee> {
    const employee = await this.store.find(requireOpaqueId(tenantId), requireOpaqueId(id));
    if (employee?.tenantId !== tenantId) throw new EmployeeError('not_found');
    return employee;
  }

  /** Writes `next`; a lost race reads as `stale_version` (or `not_found` when the row is gone). */
  private async commit(
    next: Employee,
    expectedVersion: number,
    entry?: EmployeeHistoryEntry,
  ): Promise<Employee> {
    if (await this.store.replace(next, expectedVersion, entry)) return next;
    const current = await this.store.find(next.tenantId, next.id);
    throw new EmployeeError(current ? 'stale_version' : 'not_found');
  }

  public async create(tenantId: string, actorId: string, input: unknown): Promise<Employee> {
    requireOpaqueId(tenantId);
    requireOpaqueId(actorId);
    const now = this.now();
    const data = parseNewEmployee(input, now);
    const id = this.newId();
    // Sealing talks to the KMS: it happens before the area lock is taken, which stays short.
    const sealed = await this.sealAll(tenantId, id, data.pii);
    const employee = newEmployee(tenantId, id, data, sealed.pii, sealed.idType ?? null, now);
    const entry = statusEntry(employee, null, this.newId(), actorId, now);
    await this.inArea(tenantId, employee.areaId, () => this.store.insert(employee, entry));
    return employee;
  }

  public get(tenantId: string, id: unknown): Promise<Employee> {
    return this.load(tenantId, id);
  }

  public async list(tenantId: string, query: EmployeeListQuery = {}): Promise<EmployeeSlice> {
    requireOpaqueId(tenantId);
    const limit = query.limit === undefined ? DEFAULT_LIST_LIMIT : query.limit;
    const offset = query.offset === undefined ? 0 : query.offset;
    if (!isInteger(limit, 1, MAX_LIST_LIMIT) || !isInteger(offset, 0, 1_000_000)) return invalid();
    if (query.kind !== undefined && !isEmployeeKind(query.kind)) return invalid();
    if (query.status !== undefined && !isEmployeeStatus(query.status)) return invalid();
    if (query.includeArchived !== undefined && typeof query.includeArchived !== 'boolean')
      return invalid();
    const filter: EmployeeFilter = {
      includeArchived: query.includeArchived ?? false,
      ...(query.kind === undefined ? {} : { kind: query.kind }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.areaId === undefined ? {} : { areaId: requireOpaqueId(query.areaId) }),
    };
    return this.store.list(tenantId, filter, { limit, offset });
  }

  public async update(
    tenantId: string,
    actorId: string,
    id: unknown,
    expectedVersion: unknown,
    input: unknown,
  ): Promise<Employee> {
    requireOpaqueId(actorId);
    const now = this.now();
    const patch = parseEmployeePatch(input, now);
    const version = requireVersion(expectedVersion);
    const current = await this.load(tenantId, id);
    if (current.kind !== 'driver') {
      const keys = new Set([...Object.keys(patch.core), ...Object.keys(patch.pii)]);
      if (LICENSE_KEYS.some((key) => keys.has(key))) return invalid();
    }
    // Cheap checks first: a stale or read-only employee never reaches the KMS.
    applyPatch(current, {}, {}, undefined, version, now);
    const sealed = await this.sealAll(tenantId, current.id, patch.pii);
    const next = applyPatch(current, patch.core, sealed.pii, sealed.idType, version, now);
    if (next.areaId === current.areaId) return this.commit(next, version);
    // Only a different area is validated: an employee may keep an area that was deactivated since.
    const entry = areaEntry(next, current.areaId, this.newId(), actorId, now);
    return this.inArea(tenantId, next.areaId, () => this.commit(next, version, entry));
  }

  public async changeStatus(
    tenantId: string,
    actorId: string,
    id: unknown,
    expectedVersion: unknown,
    status: unknown,
    reason: unknown,
  ): Promise<Employee> {
    requireOpaqueId(actorId);
    const now = this.now();
    if (!isEmployeeStatus(status)) return invalid();
    const text = normalizeReason(reason);
    const version = requireVersion(expectedVersion);
    const current = await this.load(tenantId, id);
    const next = applyStatus(current, status, text, version, now);
    return this.commit(
      next,
      version,
      statusEntry(next, current.status, this.newId(), actorId, now),
    );
  }

  public async archive(tenantId: string, id: unknown, expectedVersion: unknown): Promise<Employee> {
    const version = requireVersion(expectedVersion);
    const current = await this.load(tenantId, id);
    return this.commit(applyArchive(current, version, this.now()), version);
  }

  public async history(
    tenantId: string,
    id: unknown,
    query: EmployeeHistoryQuery = {},
  ): Promise<EmployeeHistorySlice> {
    const employee = await this.load(tenantId, id);
    return this.store.history(tenantId, employee.id, windowOf(query));
  }

  /** Derived fitness to operate as of today (UTC date of the service clock). */
  public fitness(employee: Employee): Fitness | null {
    return fitnessOf(employee, dateOf(this.now()));
  }

  /**
   * Decrypts the personal data of an employee. The caller (composition) decides who may call it;
   * the tenant comes from the employee row, which was loaded for the session's tenant.
   */
  public async reveal(employee: Employee): Promise<EmployeePiiValues> {
    const open = async (field: PiiField): Promise<string | null> => {
      const sealed = employee.pii[field];
      return sealed === null
        ? null
        : this.pii.open(
            {
              tenantId: employee.tenantId,
              entityType: ENTITY,
              entityId: employee.id,
              field: PII_FIELD_LABEL[field],
            },
            sealed.sealed,
          );
    };
    return {
      nationalId: await open('nationalId'),
      phone: await open('phone'),
      email: await open('email'),
      licenseNumber: await open('licenseNumber'),
    };
  }
}

/** True when the raw input of a create or update writes personal data (needs the PII permission). */
export function writesPii(input: unknown): boolean {
  return (
    typeof input === 'object' &&
    input !== null &&
    !Array.isArray(input) &&
    PII_INPUT_KEYS.some((key) => Object.hasOwn(input, key))
  );
}
