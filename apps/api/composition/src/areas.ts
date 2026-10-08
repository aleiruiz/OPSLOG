import {
  AreaError,
  type Area,
  type AreaHistoryEntry,
  type AreaHistoryQuery,
  type AreaListQuery,
  type AreaResource,
  type AreaService,
} from '../../../../packages/domain/areas/src/index.js';
import {
  AuthError,
  type Permission,
  type TenantContext,
} from '../../../../packages/domain/identity/src/index.js';
import type { PlatformResponse } from './platform.js';

export type AreaApiErrorCode =
  | 'invalid_input'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'duplicate'
  | 'stale_version'
  | 'invalid_transition'
  | 'immutable'
  | 'invalid_hierarchy'
  | 'invalid_responsible'
  | 'area_in_use'
  | 'internal_error';

const STATUS: Readonly<Record<AreaApiErrorCode, number>> = {
  invalid_input: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  duplicate: 409,
  stale_version: 409,
  invalid_transition: 409,
  immutable: 409,
  area_in_use: 409,
  invalid_hierarchy: 422,
  invalid_responsible: 422,
  internal_error: 500,
};

/**
 * Maps any failure to a safe payload: a code, its status, a generic message and, for a duplicate
 * or an in-use area, the name of the colliding key or blocking resource kind. Never a stack, an SQL
 * fragment, a count or a value from the request.
 */
function failure(error: unknown): PlatformResponse<never> {
  let code: AreaApiErrorCode = 'internal_error';
  let field: string | undefined;
  if (error instanceof AreaError) {
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
      message: code === 'internal_error' ? 'Request failed' : `Area request rejected: ${code}`,
      ...(field === undefined ? {} : { field }),
    },
  };
}

/** What the browser may know about an area. The company is never part of it. */
export interface AreaView {
  readonly id: string;
  readonly name: string;
  readonly code: string | null;
  readonly parentId: string | null;
  readonly depth: number;
  readonly active: boolean;
  /** Opaque ids of the responsible users (never names or emails). */
  readonly responsibleIds: readonly string[];
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deactivatedAt: string | null;
}

export interface AreaDetailView extends AreaView {
  /** Active resources assigned to the area, by kind (BR-021). */
  readonly resourceCounts: Readonly<Record<AreaResource, number>>;
}

export interface AreaHistoryEntryView {
  readonly id: string;
  readonly action: AreaHistoryEntry['action'];
  readonly fields: AreaHistoryEntry['fields'];
  readonly fromParentId: string | null;
  readonly toParentId: string | null;
  readonly actorId: string;
  readonly version: number;
  readonly at: string;
}

export interface AreaListView {
  readonly items: readonly AreaView[];
  readonly total: number;
}
export interface AreaHistoryView {
  readonly items: readonly AreaHistoryEntryView[];
  readonly total: number;
}

const view = (area: Area): AreaView => ({
  id: area.id,
  name: area.name,
  code: area.code,
  parentId: area.parentId,
  depth: area.depth,
  active: area.active,
  responsibleIds: [...area.responsibleIds],
  version: area.version,
  createdAt: area.createdAt,
  updatedAt: area.updatedAt,
  deactivatedAt: area.deactivatedAt,
});

export type AreaAuditAction =
  | 'area.created'
  | 'area.updated'
  | 'area.moved'
  | 'area.activated'
  | 'area.deactivated';

export interface AreasApiDeps {
  readonly service: AreaService;
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
    action: AreaAuditAction,
    entityId: string,
    correlationId: string,
  ) => void | Promise<void>;
}

/**
 * Permissions per operation. The platform has no module-scoped permissions yet (area-scoped
 * permissions, FR-022, are phase 1.5), so the generic ones are used exactly as for vehicles:
 * reading needs `view`, creating `create`, every change of an existing area (edit, move,
 * responsibles, reactivation) `edit`, and deactivation (the soft delete) `delete`.
 */
export const AREA_PERMISSIONS = {
  read: ['view'],
  create: ['create'],
  change: ['edit'],
  deactivate: ['delete'],
} as const satisfies Record<string, readonly Permission[]>;

/**
 * Area use cases for the HTTP layer. Every call authenticates the session and re-resolves the role
 * (nothing is cached), takes the tenant only from that session, and audits successful writes with
 * the action, the entity id and the actor (`user-<subject>`): no names, codes or responsible ids. Serialization of concurrent
 * hierarchy changes is the store's job (a per-tenant transaction lock).
 */
export class AreasApi {
  public constructor(private readonly deps: AreasApiDeps) {}

  private actorOf = (context: TenantContext): string => `user-${context.actor.subject}`;

  private async write(
    token: string,
    correlationId: string,
    permissions: readonly Permission[],
    work: (context: TenantContext) => Promise<{ area: Area; audit: readonly AreaAuditAction[] }>,
  ): Promise<PlatformResponse<AreaView>> {
    try {
      const context = await this.deps.authorize(token, correlationId, permissions);
      const { area, audit } = await work(context);
      for (const action of audit) await this.deps.audit(context, action, area.id, correlationId);
      return { ok: true, value: view(area) };
    } catch (error) {
      return failure(error);
    }
  }

  public create(
    token: string,
    correlationId: string,
    input: unknown,
  ): Promise<PlatformResponse<AreaView>> {
    return this.write(token, correlationId, AREA_PERMISSIONS.create, async (c) => ({
      area: await this.deps.service.create(c.tenantId, this.actorOf(c), input),
      audit: ['area.created'],
    }));
  }

  public update(
    token: string,
    correlationId: string,
    id: unknown,
    version: unknown,
    patch: unknown,
  ): Promise<PlatformResponse<AreaView>> {
    return this.write(token, correlationId, AREA_PERMISSIONS.change, async (c) => {
      const { area, fields } = await this.deps.service.update(
        c.tenantId,
        this.actorOf(c),
        id,
        version,
        patch,
      );
      // A no-op edit changes nothing and is not audited; a move is audited in addition to the edit.
      return {
        area,
        audit:
          fields.length === 0
            ? []
            : fields.includes('parent')
              ? ['area.updated', 'area.moved']
              : ['area.updated'],
      };
    });
  }

  public deactivate(
    token: string,
    correlationId: string,
    id: unknown,
    version: unknown,
  ): Promise<PlatformResponse<AreaView>> {
    return this.write(token, correlationId, AREA_PERMISSIONS.deactivate, async (c) => ({
      area: await this.deps.service.deactivate(c.tenantId, this.actorOf(c), id, version),
      audit: ['area.deactivated'],
    }));
  }

  public activate(
    token: string,
    correlationId: string,
    id: unknown,
    version: unknown,
  ): Promise<PlatformResponse<AreaView>> {
    return this.write(token, correlationId, AREA_PERMISSIONS.change, async (c) => ({
      area: await this.deps.service.activate(c.tenantId, this.actorOf(c), id, version),
      audit: ['area.activated'],
    }));
  }

  public async get(
    token: string,
    correlationId: string,
    id: unknown,
  ): Promise<PlatformResponse<AreaDetailView>> {
    try {
      const context = await this.deps.authorize(token, correlationId, AREA_PERMISSIONS.read);
      const area = await this.deps.service.get(context.tenantId, id);
      const resourceCounts = await this.deps.service.usage(context.tenantId, area.id);
      return { ok: true, value: { ...view(area), resourceCounts } };
    } catch (error) {
      return failure(error);
    }
  }

  public async list(
    token: string,
    correlationId: string,
    query: AreaListQuery,
  ): Promise<PlatformResponse<AreaListView & { tenantId: string }>> {
    try {
      const context = await this.deps.authorize(token, correlationId, AREA_PERMISSIONS.read);
      const slice = await this.deps.service.list(context.tenantId, query);
      return {
        ok: true,
        value: { tenantId: context.tenantId, items: slice.items.map(view), total: slice.total },
      };
    } catch (error) {
      return failure(error);
    }
  }

  public async history(
    token: string,
    correlationId: string,
    id: unknown,
    query: AreaHistoryQuery,
  ): Promise<PlatformResponse<AreaHistoryView & { tenantId: string }>> {
    try {
      const context = await this.deps.authorize(token, correlationId, AREA_PERMISSIONS.read);
      const slice = await this.deps.service.history(context.tenantId, id, query);
      return {
        ok: true,
        value: {
          tenantId: context.tenantId,
          total: slice.total,
          items: slice.items.map((entry) => ({
            id: entry.id,
            action: entry.action,
            fields: [...entry.fields],
            fromParentId: entry.fromParentId,
            toParentId: entry.toParentId,
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
