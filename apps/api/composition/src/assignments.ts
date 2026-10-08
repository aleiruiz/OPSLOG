import {
  AssignmentError,
  isCurrent,
  type Assigned,
  type Assignment,
  type AssignmentEvent,
  type AssignmentHistoryQuery,
  type AssignmentListQuery,
  type AssignmentService,
} from '../../../../packages/domain/assignments/src/index.js';
import {
  AuthError,
  type Permission,
  type TenantContext,
} from '../../../../packages/domain/identity/src/index.js';
import type { PlatformResponse } from './platform.js';

export type AssignmentsApiErrorCode =
  | 'invalid_input'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'stale_version'
  | 'immutable'
  | 'invalid_vehicle'
  | 'invalid_employee'
  | 'principal_taken'
  | 'already_assigned'
  | 'internal_error';

const STATUS: Readonly<Record<AssignmentsApiErrorCode, number>> = {
  invalid_input: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  stale_version: 409,
  immutable: 409,
  principal_taken: 409,
  already_assigned: 409,
  invalid_vehicle: 422,
  invalid_employee: 422,
  internal_error: 500,
};

/**
 * Maps any failure to a safe payload: a code, its status, a generic message and, for the codes that
 * name one, the field (`vehicle_id`, `employee_id`). Never a stack, an SQL fragment or a value from
 * the request: anything that is not an `AssignmentError` or an `AuthError` (including store errors)
 * is a plain 500.
 */
function failure(error: unknown): PlatformResponse<never> {
  let code: AssignmentsApiErrorCode = 'internal_error';
  let field: string | undefined;
  if (error instanceof AssignmentError) {
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
      message:
        code === 'internal_error' ? 'Request failed' : `Assignment request rejected: ${code}`,
      ...(field === undefined ? {} : { field }),
    },
  };
}

/** What the browser may know about an assignment. The company is never part of it. */
export interface AssignmentView {
  readonly id: string;
  readonly vehicleId: string;
  readonly employeeId: string;
  readonly type: Assignment['type'];
  readonly reason: string;
  readonly assignedBy: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly endKind: Assignment['endKind'];
  readonly endReason: string | null;
  readonly endedBy: string | null;
  /** Derived from `endedAt`: true while the assignment has not ended. */
  readonly current: boolean;
  readonly version: number;
  readonly updatedAt: string;
}

export interface AssignmentEventView {
  readonly seq: number;
  readonly kind: AssignmentEvent['kind'];
  readonly actorId: string;
  readonly reason: string;
  readonly at: string;
}

export interface AssignedView {
  readonly assignment: AssignmentView;
  /** The principal closed by `replace`, when there was one. */
  readonly replaced: AssignmentView | null;
}

export interface AssignmentListView {
  readonly items: readonly AssignmentView[];
  readonly total: number;
}

export interface AssignmentHistoryView {
  readonly items: readonly AssignmentEventView[];
  readonly total: number;
}

export type AssignmentsAuditAction = 'vehicle_assignment.created' | 'vehicle_assignment.ended';

export interface AssignmentsApiDeps {
  readonly service: AssignmentService;
  /**
   * Authenticates the session (including the tenant gate), re-resolves the role and requires every
   * permission. The tenant and the actor of the returned context are the only ones ever used.
   */
  readonly authorize: (
    token: string,
    correlationId: string,
    required: readonly Permission[],
  ) => Promise<TenantContext>;
  /** Appends an audit event of the session's tenant and actor. Entity ids only, never field values. */
  readonly audit: (
    context: TenantContext,
    action: AssignmentsAuditAction,
    entityId: string,
    correlationId: string,
  ) => void | Promise<void>;
}

/**
 * Permissions per operation. The platform has no module-scoped permissions yet (open question in
 * the task document), so the generic ones are used: reading needs `view`, assigning `create` and
 * closing an assignment `edit`. A replacement (`replace: true`) also closes the current principal,
 * so it needs `edit` on top of `create`. Assignments are never deleted.
 */
export const ASSIGNMENT_PERMISSIONS = {
  read: ['view'],
  create: ['create'],
  replace: ['create', 'edit'],
  end: ['edit'],
} as const satisfies Record<string, readonly Permission[]>;

/** True when the input asks to replace the vehicle's principal (any other value is for the domain to reject). */
const asksToReplace = (input: unknown): boolean =>
  typeof input === 'object' &&
  input !== null &&
  !Array.isArray(input) &&
  (input as Record<string, unknown>)['replace'] === true;

/**
 * Assignment use cases for the HTTP layer. Every call authenticates the session and re-resolves
 * the role (nothing is cached), takes the tenant only from that session, and audits successful
 * writes (ids and actions only). The cross-module rules (the vehicle and the driver can receive an
 * assignment) are enforced by the service through the gates wired in `platform.ts`.
 */
export class AssignmentsApi {
  public constructor(private readonly deps: AssignmentsApiDeps) {}

  private viewOf(assignment: Assignment): AssignmentView {
    return {
      id: assignment.id,
      vehicleId: assignment.vehicleId,
      employeeId: assignment.employeeId,
      type: assignment.type,
      reason: assignment.reason,
      assignedBy: assignment.assignedBy,
      startedAt: assignment.startedAt,
      endedAt: assignment.endedAt,
      endKind: assignment.endKind,
      endReason: assignment.endReason,
      endedBy: assignment.endedBy,
      current: isCurrent(assignment),
      version: assignment.version,
      updatedAt: assignment.updatedAt,
    };
  }

  private actorOf = (context: TenantContext): string => `user-${context.actor.subject}`;

  public async create(
    token: string,
    correlationId: string,
    input: unknown,
  ): Promise<PlatformResponse<AssignedView>> {
    try {
      const context = await this.deps.authorize(
        token,
        correlationId,
        asksToReplace(input) ? ASSIGNMENT_PERMISSIONS.replace : ASSIGNMENT_PERMISSIONS.create,
      );
      const { assignment, replaced }: Assigned = await this.deps.service.create(
        context.tenantId,
        this.actorOf(context),
        input,
      );
      if (replaced)
        await this.deps.audit(context, 'vehicle_assignment.ended', replaced.id, correlationId);
      await this.deps.audit(context, 'vehicle_assignment.created', assignment.id, correlationId);
      return {
        ok: true,
        value: {
          assignment: this.viewOf(assignment),
          replaced: replaced ? this.viewOf(replaced) : null,
        },
      };
    } catch (error) {
      return failure(error);
    }
  }

  public async end(
    token: string,
    correlationId: string,
    id: unknown,
    version: unknown,
    input: unknown,
  ): Promise<PlatformResponse<AssignmentView>> {
    try {
      const context = await this.deps.authorize(token, correlationId, ASSIGNMENT_PERMISSIONS.end);
      const ended = await this.deps.service.end(
        context.tenantId,
        this.actorOf(context),
        id,
        version,
        input,
      );
      await this.deps.audit(context, 'vehicle_assignment.ended', ended.id, correlationId);
      return { ok: true, value: this.viewOf(ended) };
    } catch (error) {
      return failure(error);
    }
  }

  public async get(
    token: string,
    correlationId: string,
    id: unknown,
  ): Promise<PlatformResponse<AssignmentView>> {
    try {
      const context = await this.deps.authorize(token, correlationId, ASSIGNMENT_PERMISSIONS.read);
      return { ok: true, value: this.viewOf(await this.deps.service.get(context.tenantId, id)) };
    } catch (error) {
      return failure(error);
    }
  }

  public async list(
    token: string,
    correlationId: string,
    query: AssignmentListQuery,
  ): Promise<PlatformResponse<AssignmentListView & { tenantId: string }>> {
    try {
      const context = await this.deps.authorize(token, correlationId, ASSIGNMENT_PERMISSIONS.read);
      const slice = await this.deps.service.list(context.tenantId, query);
      return {
        ok: true,
        value: {
          tenantId: context.tenantId,
          items: slice.items.map((assignment) => this.viewOf(assignment)),
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
    query: AssignmentHistoryQuery,
  ): Promise<PlatformResponse<AssignmentHistoryView & { tenantId: string }>> {
    try {
      const context = await this.deps.authorize(token, correlationId, ASSIGNMENT_PERMISSIONS.read);
      const slice = await this.deps.service.history(context.tenantId, id, query);
      return {
        ok: true,
        value: {
          tenantId: context.tenantId,
          total: slice.total,
          items: slice.items.map(
            (event): AssignmentEventView => ({
              seq: event.seq,
              kind: event.kind,
              actorId: event.actorId,
              reason: event.reason,
              at: event.at,
            }),
          ),
        },
      };
    } catch (error) {
      return failure(error);
    }
  }
}
