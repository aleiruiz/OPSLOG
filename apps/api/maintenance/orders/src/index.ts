import type {
  Permission,
  TenantContext,
} from '../../../../../packages/domain/identity/src/index.js';
import {
  WorkOrderError,
  transitionView,
  workOrderView,
  type WorkOrder,
  type WorkOrderActor,
  type WorkOrderService,
  type WorkOrderTransitionView,
  type WorkOrderView,
} from '../../../../../packages/domain/maintenance/orders/src/index.js';

export type WorkOrderApiErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'invalid_input'
  | 'not_found'
  | 'stale_version'
  | 'invalid_transition'
  | 'duplicate'
  | 'invalid_association'
  | 'missing_requirements'
  | 'internal_error';
export interface WorkOrderApiResponse<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly error?: {
    readonly code: WorkOrderApiErrorCode;
    readonly status: number;
    readonly message: string;
    readonly missingRequirements?: readonly string[];
  };
}
export interface WorkOrderApiDeps {
  readonly orders: WorkOrderService;
  /** Authenticates the session and returns its effective grants (never from the request). */
  readonly authorize: (
    token: string,
    correlationId: string,
  ) => Promise<{ readonly context: TenantContext; readonly permissions: readonly Permission[] }>;
  readonly mechanicIdsOfMember: (tenantId: string, memberId: string) => Promise<readonly string[]>;
  /** Whether the member has any mechanic record, active or not (stable source of D9 scope). */
  readonly mechanicLinked?: (tenantId: string, memberId: string) => Promise<boolean>;
}

const STATUS: Readonly<Record<WorkOrderApiErrorCode, number>> = {
  unauthorized: 401,
  forbidden: 403,
  invalid_input: 400,
  not_found: 404,
  stale_version: 409,
  invalid_transition: 409,
  duplicate: 409,
  invalid_association: 409,
  missing_requirements: 422,
  internal_error: 500,
};
const KNOWN = new Set<string>(Object.keys(STATUS));

function fail(error: unknown): WorkOrderApiResponse<never> {
  const raw =
    error instanceof WorkOrderError
      ? error.code
      : typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code: unknown }).code)
        : '';
  const code: WorkOrderApiErrorCode =
    raw === 'expired'
      ? 'unauthorized'
      : KNOWN.has(raw)
        ? (raw as WorkOrderApiErrorCode)
        : 'internal_error';
  return {
    ok: false,
    error: {
      code,
      status: STATUS[code],
      message:
        code === 'internal_error' ? 'Request failed' : `Work order request rejected: ${code}`,
      ...(error instanceof WorkOrderError && code === 'missing_requirements'
        ? { missingRequirements: error.missingRequirements }
        : {}),
    },
  };
}

type Command =
  | 'assign'
  | 'start'
  | 'complete'
  | 'approveClose'
  | 'close'
  | 'cancel'
  | 'reopen'
  | 'updateWork'
  | 'updateCosts';

/** Work order endpoints. Tenant, actor, grants and mechanic identity come only from the session. */
export class WorkOrderApi {
  public constructor(private readonly deps: WorkOrderApiDeps) {}

  private async run<T>(
    token: string,
    correlationId: string,
    work: (tenantId: string, actor: WorkOrderActor, viewCosts: boolean) => Promise<T>,
  ): Promise<WorkOrderApiResponse<T>> {
    try {
      const { context, permissions } = await this.deps.authorize(token, correlationId);
      const mechanicIds = await this.deps.mechanicIdsOfMember(
        context.tenantId,
        context.actor.subject,
      );
      const mechanicLinked =
        mechanicIds.length > 0 ||
        (await this.deps.mechanicLinked?.(context.tenantId, context.actor.subject)) === true;
      const actor: WorkOrderActor = {
        id: `user-${context.actor.subject}`,
        subject: context.actor.subject,
        permissions,
        mechanicIds,
        mechanicLinked,
      };
      return {
        ok: true,
        value: await work(context.tenantId, actor, permissions.includes('view_costs')),
      };
    } catch (error) {
      return fail(error);
    }
  }
  private view(
    token: string,
    correlationId: string,
    work: (tenantId: string, actor: WorkOrderActor) => Promise<WorkOrder>,
  ) {
    return this.run(token, correlationId, async (tenantId, actor, viewCosts) =>
      workOrderView(await work(tenantId, actor), viewCosts),
    );
  }

  public list(
    token: string,
    correlationId: string,
  ): Promise<WorkOrderApiResponse<readonly WorkOrderView[]>> {
    return this.run(token, correlationId, async (tenantId, actor, viewCosts) =>
      (await this.deps.orders.list(tenantId, actor)).map((order) =>
        workOrderView(order, viewCosts),
      ),
    );
  }
  public get(
    token: string,
    correlationId: string,
    id: string,
  ): Promise<WorkOrderApiResponse<WorkOrderView>> {
    return this.view(token, correlationId, (tenantId, actor) =>
      this.deps.orders.get(tenantId, actor, id),
    );
  }
  public history(
    token: string,
    correlationId: string,
    id: string,
  ): Promise<WorkOrderApiResponse<readonly WorkOrderTransitionView[]>> {
    return this.run(token, correlationId, async (tenantId, actor, viewCosts) =>
      (await this.deps.orders.history(tenantId, actor, id)).map((entry) =>
        transitionView(entry, viewCosts),
      ),
    );
  }
  public createCorrective(
    token: string,
    correlationId: string,
    input: unknown,
  ): Promise<WorkOrderApiResponse<WorkOrderView>> {
    return this.view(token, correlationId, (tenantId, actor) =>
      this.deps.orders.createCorrective(tenantId, actor, input),
    );
  }
  public adoptPreventive(
    token: string,
    correlationId: string,
    input: unknown,
  ): Promise<WorkOrderApiResponse<WorkOrderView>> {
    return this.view(token, correlationId, (tenantId, actor) =>
      this.deps.orders.adoptPreventive(tenantId, actor, input),
    );
  }
  public command(
    token: string,
    correlationId: string,
    command: Command,
    id: string,
    input: unknown,
  ): Promise<WorkOrderApiResponse<WorkOrderView>> {
    return this.view(token, correlationId, (tenantId, actor) =>
      this.deps.orders[command](tenantId, actor, id, input),
    );
  }
}
