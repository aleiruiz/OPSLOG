import {
  PolicyError,
  writesDeductible,
  type Deductible,
  type Policy,
  type PolicyHistoryQuery,
  type PolicyListQuery,
  type PolicyRevision,
  type PolicyService,
  type PolicyStatus,
  type RevisionStatus,
} from '../../../../packages/domain/insurance/src/index.js';
import {
  AuthError,
  type Permission,
  type TenantContext,
} from '../../../../packages/domain/identity/src/index.js';
import type { PlatformResponse } from './platform.js';

export type InsuranceApiErrorCode =
  | 'invalid_input'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'stale_version'
  | 'immutable'
  | 'invalid_vehicle'
  | 'internal_error';

const STATUS: Readonly<Record<InsuranceApiErrorCode, number>> = {
  invalid_input: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  stale_version: 409,
  immutable: 409,
  invalid_vehicle: 422,
  internal_error: 500,
};

/**
 * Maps any failure to a safe payload: a code, its status, a generic message and, for an invalid
 * vehicle, the name of the field (`vehicle_id`). Never a stack, an SQL fragment or a value from the
 * request: anything that is not a `PolicyError` or an `AuthError` (including store errors) is a
 * plain 500.
 */
function failure(error: unknown): PlatformResponse<never> {
  let code: InsuranceApiErrorCode = 'internal_error';
  let field: string | undefined;
  if (error instanceof PolicyError) {
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
      message: code === 'internal_error' ? 'Request failed' : `Policy request rejected: ${code}`,
      ...(field === undefined ? {} : { field }),
    },
  };
}

/**
 * What the browser may know about a policy. The company is never part of it. The deductible is
 * financial data (`view_costs`): without that permission it is `null` and only `hasDeductible`
 * tells that one exists.
 */
export interface PolicyView {
  readonly id: string;
  readonly vehicleId: string;
  readonly insurer: string;
  readonly coverageNotes: string | null;
  readonly revision: number;
  readonly policyNumber: string;
  readonly coverageType: Policy['coverageType'];
  readonly startsOn: string;
  readonly endsOn: string;
  /** Derived from the end date and the service clock; never stored. */
  readonly status: PolicyStatus;
  /** Whole days to the last day of coverage (negative once expired). */
  readonly daysToExpiry: number;
  /** Whether the period contains today (a policy that has not started is `valid` but not covering). */
  readonly covering: boolean;
  readonly hasDeductible: boolean;
  readonly deductible: Deductible | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

export interface PolicyRevisionView {
  readonly revision: number;
  readonly policyNumber: string;
  readonly coverageType: Policy['coverageType'];
  readonly startsOn: string;
  readonly endsOn: string;
  readonly status: RevisionStatus;
  readonly hasDeductible: boolean;
  readonly deductible: Deductible | null;
  readonly actorId: string;
  readonly at: string;
}

export interface PolicyListView {
  readonly items: readonly PolicyView[];
  readonly total: number;
}

export interface PolicyHistoryView {
  readonly items: readonly PolicyRevisionView[];
  readonly total: number;
}

export type InsuranceAuditAction =
  | 'insurance_policy.created'
  | 'insurance_policy.updated'
  | 'insurance_policy.renewed'
  | 'insurance_policy.archived';

export interface InsuranceApiDeps {
  readonly service: PolicyService;
  /**
   * Authenticates the session (including the tenant gate), re-resolves the role and requires every
   * permission. The tenant and the actor of the returned context are the only ones ever used.
   */
  readonly authorize: (
    token: string,
    correlationId: string,
    required: readonly Permission[],
  ) => Promise<TenantContext>;
  /** Whether the session's current role holds `permission` (re-resolved, never cached). */
  readonly can: (context: TenantContext, permission: Permission) => Promise<boolean>;
  /** Appends an audit event of the session's tenant and actor. Entity ids only, never field values. */
  readonly audit: (
    context: TenantContext,
    action: InsuranceAuditAction,
    entityId: string,
    correlationId: string,
  ) => void | Promise<void>;
}

/**
 * Permissions per operation. The platform has no module-scoped permissions yet (open question in
 * the task document), so the generic ones are used: reading needs `view`, creating `create`,
 * every change of an existing policy (edit, renewal) `edit`, and archiving (soft delete)
 * `delete`. The deductible is an amount (BRD §12.5, `view_costs`): reading it and also writing it
 * need `view_costs` on top of the operation's own permission.
 */
export const INSURANCE_PERMISSIONS = {
  read: ['view'],
  create: ['create'],
  change: ['edit'],
  archive: ['delete'],
  costs: ['view_costs'],
} as const satisfies Record<string, readonly Permission[]>;

/**
 * Insurance policy use cases for the HTTP layer. Every call authenticates the session and
 * re-resolves the role (nothing is cached), takes the tenant only from that session, and audits
 * successful writes (ids and actions only). The one cross-module rule, that the vehicle is a live
 * vehicle of the tenant, is enforced by the service through the vehicle gate wired in `platform.ts`.
 */
export class InsuranceApi {
  public constructor(private readonly deps: InsuranceApiDeps) {}

  private viewOf(policy: Policy, costs: boolean): PolicyView {
    const expiry = this.deps.service.expiry(policy);
    return {
      id: policy.id,
      vehicleId: policy.vehicleId,
      insurer: policy.insurer,
      coverageNotes: policy.coverageNotes,
      revision: policy.revision,
      policyNumber: policy.policyNumber,
      coverageType: policy.coverageType,
      startsOn: policy.startsOn,
      endsOn: policy.endsOn,
      status: expiry.status,
      daysToExpiry: expiry.daysToExpiry as number,
      covering: this.deps.service.covering(policy),
      hasDeductible: policy.deductible !== null,
      deductible: costs ? policy.deductible : null,
      version: policy.version,
      createdAt: policy.createdAt,
      updatedAt: policy.updatedAt,
      archivedAt: policy.archivedAt,
    };
  }

  private async write(
    token: string,
    correlationId: string,
    permissions: readonly Permission[],
    action: InsuranceAuditAction,
    work: (context: TenantContext) => Promise<Policy>,
  ): Promise<PlatformResponse<PolicyView>> {
    try {
      const context = await this.deps.authorize(token, correlationId, permissions);
      // Resolved before anything is written: a failure here must never follow a committed write
      // (the caller would retry and write twice).
      const costs = await this.deps.can(context, 'view_costs');
      const policy = await work(context);
      await this.deps.audit(context, action, policy.id, correlationId);
      return { ok: true, value: this.viewOf(policy, costs) };
    } catch (error) {
      return failure(error);
    }
  }

  private actorOf = (context: TenantContext): string => `user-${context.actor.subject}`;

  /** Mentioning the deductible (even as `null`) needs `view_costs` on top of the operation's own permission. */
  private withCosts(base: readonly Permission[], input: unknown): readonly Permission[] {
    return writesDeductible(input) ? [...base, ...INSURANCE_PERMISSIONS.costs] : base;
  }

  public create(
    token: string,
    correlationId: string,
    input: unknown,
  ): Promise<PlatformResponse<PolicyView>> {
    return this.write(
      token,
      correlationId,
      this.withCosts(INSURANCE_PERMISSIONS.create, input),
      'insurance_policy.created',
      (c) => this.deps.service.create(c.tenantId, this.actorOf(c), input),
    );
  }

  public update(
    token: string,
    correlationId: string,
    id: unknown,
    version: unknown,
    patch: unknown,
  ): Promise<PlatformResponse<PolicyView>> {
    return this.write(
      token,
      correlationId,
      INSURANCE_PERMISSIONS.change,
      'insurance_policy.updated',
      (c) => this.deps.service.update(c.tenantId, id, version, patch),
    );
  }

  public renew(
    token: string,
    correlationId: string,
    id: unknown,
    version: unknown,
    input: unknown,
  ): Promise<PlatformResponse<PolicyView>> {
    return this.write(
      token,
      correlationId,
      this.withCosts(INSURANCE_PERMISSIONS.change, input),
      'insurance_policy.renewed',
      (c) => this.deps.service.renew(c.tenantId, this.actorOf(c), id, version, input),
    );
  }

  public archive(
    token: string,
    correlationId: string,
    id: unknown,
    version: unknown,
  ): Promise<PlatformResponse<PolicyView>> {
    return this.write(
      token,
      correlationId,
      INSURANCE_PERMISSIONS.archive,
      'insurance_policy.archived',
      (c) => this.deps.service.archive(c.tenantId, id, version),
    );
  }

  public async get(
    token: string,
    correlationId: string,
    id: unknown,
  ): Promise<PlatformResponse<PolicyView>> {
    try {
      const context = await this.deps.authorize(token, correlationId, INSURANCE_PERMISSIONS.read);
      const policy = await this.deps.service.get(context.tenantId, id);
      return {
        ok: true,
        value: this.viewOf(policy, await this.deps.can(context, 'view_costs')),
      };
    } catch (error) {
      return failure(error);
    }
  }

  public async list(
    token: string,
    correlationId: string,
    query: PolicyListQuery,
  ): Promise<PlatformResponse<PolicyListView & { tenantId: string }>> {
    try {
      const context = await this.deps.authorize(token, correlationId, INSURANCE_PERMISSIONS.read);
      const slice = await this.deps.service.list(context.tenantId, query);
      const costs = await this.deps.can(context, 'view_costs');
      return {
        ok: true,
        value: {
          tenantId: context.tenantId,
          items: slice.items.map((policy) => this.viewOf(policy, costs)),
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
    query: PolicyHistoryQuery,
  ): Promise<PlatformResponse<PolicyHistoryView & { tenantId: string }>> {
    try {
      const context = await this.deps.authorize(token, correlationId, INSURANCE_PERMISSIONS.read);
      const slice = await this.deps.service.history(context.tenantId, id, query);
      const costs = await this.deps.can(context, 'view_costs');
      return {
        ok: true,
        value: {
          tenantId: context.tenantId,
          total: slice.total,
          items: slice.items.map(
            (row: PolicyRevision & { status: RevisionStatus }): PolicyRevisionView => ({
              revision: row.revision,
              policyNumber: row.policyNumber,
              coverageType: row.coverageType,
              startsOn: row.startsOn,
              endsOn: row.endsOn,
              status: row.status,
              hasDeductible: row.deductible !== null,
              deductible: costs ? row.deductible : null,
              actorId: row.actorId,
              at: row.at,
            }),
          ),
        },
      };
    } catch (error) {
      return failure(error);
    }
  }
}
