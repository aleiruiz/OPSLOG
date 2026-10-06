import {
  EmployeeError,
  writesPii,
  type Employee,
  type EmployeeHistoryEntry,
  type EmployeeListQuery,
  type EmployeeHistoryQuery,
  type EmployeePiiValues,
  type EmployeeService,
  type Fitness,
  PII_FIELDS,
} from '../../../../packages/domain/employees/src/index.js';
import {
  AuthError,
  type Permission,
  type TenantContext,
} from '../../../../packages/domain/identity/src/index.js';
import type { PlatformResponse } from './platform.js';

export type EmployeeApiErrorCode =
  | 'invalid_input'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'duplicate'
  | 'stale_version'
  | 'invalid_transition'
  | 'immutable'
  | 'invalid_area'
  | 'internal_error';

const STATUS: Readonly<Record<EmployeeApiErrorCode, number>> = {
  invalid_input: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  duplicate: 409,
  stale_version: 409,
  invalid_transition: 409,
  immutable: 409,
  invalid_area: 422,
  internal_error: 500,
};

/**
 * Maps any failure to a safe payload: a code, its status, a generic message and, for a duplicate,
 * the name of the colliding field (or `area_id` for an invalid area). Never a stack, an SQL
 * fragment, a KMS or cipher message, or a value from the request: anything that is not an
 * `EmployeeError` or an `AuthError` (including `PiiError` and store errors) is a plain 500.
 */
function failure(error: unknown): PlatformResponse<never> {
  let code: EmployeeApiErrorCode = 'internal_error';
  let field: string | undefined;
  if (error instanceof EmployeeError) {
    code = error.code;
    field = error.field;
  } else if (error instanceof AuthError) {
    code =
      error.code === 'unauthorized' || error.code === 'expired'
        ? 'unauthorized'
        : error.code === 'forbidden'
          ? 'forbidden'
          : error.code === 'invalid_input'
            ? 'invalid_input'
            : 'internal_error';
  }
  return {
    ok: false,
    error: {
      code,
      status: STATUS[code],
      message: code === 'internal_error' ? 'Request failed' : `Employee request rejected: ${code}`,
      ...(field === undefined ? {} : { field }),
    },
  };
}

/** Which personal data an employee has on file. Presence only, never a value: safe for every reader. */
export type PiiPresence = { readonly [K in (typeof PII_FIELDS)[number]]: boolean };

/** What the browser may know about an employee without the PII permission. The company is never part of it. */
export interface EmployeeView {
  readonly id: string;
  readonly kind: Employee['kind'];
  readonly firstName: string;
  readonly lastName: string;
  readonly employeeNumber: string | null;
  readonly position: string | null;
  readonly hireDate: string | null;
  readonly areaId: string;
  readonly status: Employee['status'];
  readonly statusReason: string;
  readonly idType: string | null;
  readonly licenseType: string | null;
  readonly licenseExpiresOn: string | null;
  readonly piiPresent: PiiPresence;
  /** Derived fitness to operate (drivers only; `null` for everyone else). */
  readonly fitness: Fitness | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

/**
 * The single-employee read. `pii` holds the decrypted values for a caller with the PII permission
 * and is `null` (masked) for everyone else.
 */
export interface EmployeeDetailView extends EmployeeView {
  readonly pii: EmployeePiiValues | null;
}

export interface EmployeeHistoryEntryView {
  readonly id: string;
  readonly kind: EmployeeHistoryEntry['kind'];
  readonly from: string | null;
  readonly to: string;
  readonly reason: string | null;
  readonly actorId: string;
  readonly version: number;
  readonly at: string;
}

export interface EmployeeListView {
  readonly items: readonly EmployeeView[];
  readonly total: number;
}

export interface EmployeeHistoryView {
  readonly items: readonly EmployeeHistoryEntryView[];
  readonly total: number;
}

/** Field by field: nothing is spread from the domain object, so a new internal field never leaks. */
const viewOf = (employee: Employee, fitness: Fitness | null): EmployeeView => ({
  id: employee.id,
  kind: employee.kind,
  firstName: employee.firstName,
  lastName: employee.lastName,
  employeeNumber: employee.employeeNumber,
  position: employee.position,
  hireDate: employee.hireDate,
  areaId: employee.areaId,
  status: employee.status,
  statusReason: employee.statusReason,
  idType: employee.idType,
  licenseType: employee.licenseType,
  licenseExpiresOn: employee.licenseExpiresOn,
  piiPresent: {
    nationalId: employee.pii.nationalId !== null,
    phone: employee.pii.phone !== null,
    email: employee.pii.email !== null,
    licenseNumber: employee.pii.licenseNumber !== null,
  },
  fitness,
  version: employee.version,
  createdAt: employee.createdAt,
  updatedAt: employee.updatedAt,
  archivedAt: employee.archivedAt,
});

export type EmployeeAuditAction =
  | 'employee.created'
  | 'employee.updated'
  | 'employee.status_changed'
  | 'employee.archived'
  | 'employee.pii_viewed';

export interface EmployeesApiDeps {
  readonly service: EmployeeService;
  /**
   * Authenticates the session (including the tenant gate), re-resolves the role and requires every
   * permission. The tenant and the actor of the returned context are the only ones ever used.
   */
  readonly authorize: (
    token: string,
    correlationId: string,
    required: readonly Permission[],
  ) => Promise<TenantContext>;
  /** Whether the session's current role grants `permission` (re-resolved on every call). */
  readonly can: (context: TenantContext, permission: Permission) => Promise<boolean>;
  /** Appends an audit event of the session's tenant and actor. Entity ids only, never field values. */
  readonly audit: (
    context: TenantContext,
    action: EmployeeAuditAction,
    entityId: string,
    correlationId: string,
  ) => void;
}

/**
 * Permissions per operation. The platform has no module-scoped permissions yet (open question in
 * the task document), so the generic ones are used: reading needs `view`, creating `create`,
 * every change of an existing employee `edit`, and archiving (soft delete) `delete`. Personal
 * data adds `view_pii`: reading it, and also writing it (see `PII_INPUT_KEYS`).
 */
export const EMPLOYEE_PERMISSIONS = {
  read: ['view'],
  create: ['create'],
  change: ['edit'],
  archive: ['delete'],
  pii: ['view_pii'],
} as const satisfies Record<string, readonly Permission[]>;

/**
 * Employees use cases for the HTTP layer. Every call authenticates the session and re-resolves the
 * role (nothing is cached), takes the tenant only from that session, and audits successful writes
 * (and every disclosure of personal data). Personal data is decrypted only by `get`, only for a
 * caller holding `view_pii`; lists and write responses carry presence flags, never values.
 * Serialization of concurrent changes is the store's job (unique keys and versioned conditional
 * writes); the one cross-module rule, that an employee's area is an active area of the tenant
 * (BR-021), is enforced by the service through the area gate wired in `platform.ts`.
 */
export class EmployeesApi {
  public constructor(private readonly deps: EmployeesApiDeps) {}

  private async write(
    token: string,
    correlationId: string,
    permissions: readonly Permission[],
    action: EmployeeAuditAction,
    work: (context: TenantContext) => Promise<Employee>,
  ): Promise<PlatformResponse<EmployeeView>> {
    try {
      const context = await this.deps.authorize(token, correlationId, permissions);
      const employee = await work(context);
      this.deps.audit(context, action, employee.id, correlationId);
      return { ok: true, value: viewOf(employee, this.deps.service.fitness(employee)) };
    } catch (error) {
      return failure(error);
    }
  }

  private actorOf = (context: TenantContext): string => `user-${context.actor.subject}`;

  /** Writing personal data needs the PII permission on top of the operation's own. */
  private withPii(base: readonly Permission[], input: unknown): readonly Permission[] {
    return writesPii(input) ? [...base, ...EMPLOYEE_PERMISSIONS.pii] : base;
  }

  public create(
    token: string,
    correlationId: string,
    input: unknown,
  ): Promise<PlatformResponse<EmployeeView>> {
    return this.write(
      token,
      correlationId,
      this.withPii(EMPLOYEE_PERMISSIONS.create, input),
      'employee.created',
      (c) => this.deps.service.create(c.tenantId, this.actorOf(c), input),
    );
  }

  public update(
    token: string,
    correlationId: string,
    id: unknown,
    version: unknown,
    patch: unknown,
  ): Promise<PlatformResponse<EmployeeView>> {
    return this.write(
      token,
      correlationId,
      this.withPii(EMPLOYEE_PERMISSIONS.change, patch),
      'employee.updated',
      (c) => this.deps.service.update(c.tenantId, this.actorOf(c), id, version, patch),
    );
  }

  public changeStatus(
    token: string,
    correlationId: string,
    id: unknown,
    version: unknown,
    status: unknown,
    reason: unknown,
  ): Promise<PlatformResponse<EmployeeView>> {
    return this.write(
      token,
      correlationId,
      EMPLOYEE_PERMISSIONS.change,
      'employee.status_changed',
      (c) =>
        this.deps.service.changeStatus(c.tenantId, this.actorOf(c), id, version, status, reason),
    );
  }

  public archive(
    token: string,
    correlationId: string,
    id: unknown,
    version: unknown,
  ): Promise<PlatformResponse<EmployeeView>> {
    return this.write(
      token,
      correlationId,
      EMPLOYEE_PERMISSIONS.archive,
      'employee.archived',
      (c) => this.deps.service.archive(c.tenantId, id, version),
    );
  }

  public async get(
    token: string,
    correlationId: string,
    id: unknown,
  ): Promise<PlatformResponse<EmployeeDetailView>> {
    try {
      const context = await this.deps.authorize(token, correlationId, EMPLOYEE_PERMISSIONS.read);
      const employee = await this.deps.service.get(context.tenantId, id);
      const view = viewOf(employee, this.deps.service.fitness(employee));
      if (!(await this.deps.can(context, 'view_pii')))
        return { ok: true, value: { ...view, pii: null } };
      const pii = await this.deps.service.reveal(employee);
      // Disclosure is audited before it is returned: if the audit cannot be written, nothing leaves.
      if (Object.values(pii).some((value) => value !== null))
        this.deps.audit(context, 'employee.pii_viewed', employee.id, correlationId);
      return { ok: true, value: { ...view, pii } };
    } catch (error) {
      return failure(error);
    }
  }

  public async list(
    token: string,
    correlationId: string,
    query: EmployeeListQuery,
  ): Promise<PlatformResponse<EmployeeListView & { tenantId: string }>> {
    try {
      const context = await this.deps.authorize(token, correlationId, EMPLOYEE_PERMISSIONS.read);
      const slice = await this.deps.service.list(context.tenantId, query);
      return {
        ok: true,
        value: {
          tenantId: context.tenantId,
          items: slice.items.map((employee) =>
            viewOf(employee, this.deps.service.fitness(employee)),
          ),
          total: slice.total,
        },
      };
    } catch (error) {
      return failure(error);
    }
  }

  public async history(
    token: string,
    correlationId: string,
    id: unknown,
    query: EmployeeHistoryQuery,
  ): Promise<PlatformResponse<EmployeeHistoryView & { tenantId: string }>> {
    try {
      const context = await this.deps.authorize(token, correlationId, EMPLOYEE_PERMISSIONS.read);
      const slice = await this.deps.service.history(context.tenantId, id, query);
      return {
        ok: true,
        value: {
          tenantId: context.tenantId,
          total: slice.total,
          items: slice.items.map((entry) => ({
            id: entry.id,
            kind: entry.kind,
            from: entry.from,
            to: entry.to,
            reason: entry.reason,
            actorId: entry.actorId,
            version: entry.version,
            at: entry.at,
          })),
        },
      };
    } catch (error) {
      return failure(error);
    }
  }
}
