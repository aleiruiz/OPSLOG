import type {
  Permission,
  TenantContext,
} from '../../../../../packages/domain/identity/src/index.js';
import {
  WorkOrderError,
  transitionView,
  workOrderView,
  type WorkOrder,
  type WorkOrderAttachmentView,
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
  /** The files module: stores an upload for the actor, and reads a released file for the caller's session. */
  readonly files: {
    readonly ingest: (
      tenantId: string,
      actorId: string,
      correlationId: string,
      input: { readonly name: string; readonly contentType: string; readonly bytes: Uint8Array },
    ) => Promise<{ readonly id: string }>;
    readonly read: (token: string, correlationId: string, fileId: string) => Promise<Uint8Array>;
  };
}

/** What the browser may know of a linked file: never the file id, the storage key or the hash. */
export interface WorkOrderFileSummary {
  readonly id: string;
  readonly kind: WorkOrderAttachmentView['kind'];
  readonly displayName: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly fileStatus: WorkOrderAttachmentView['fileStatus'];
  readonly attachedBy: string;
  readonly attachedAt: string;
}
export interface WorkOrderFileContent {
  readonly displayName: string;
  readonly contentType: string;
  readonly contentBase64: string;
}

/** Largest file accepted (mirrors the contract); the decoded size is checked, not the claimed one. */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

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
const bad = (): never => {
  throw new WorkOrderError('invalid_input');
};
const summarize = ({
  id,
  kind,
  displayName,
  contentType,
  sizeBytes,
  fileStatus,
  attachedBy,
  attachedAt,
}: WorkOrderAttachmentView): WorkOrderFileSummary => ({
  id,
  kind,
  displayName,
  contentType,
  sizeBytes,
  fileStatus,
  attachedBy,
  attachedAt,
});

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
  public listFiles(
    token: string,
    correlationId: string,
    id: string,
  ): Promise<WorkOrderApiResponse<readonly WorkOrderFileSummary[]>> {
    return this.run(token, correlationId, async (tenantId, actor) =>
      (await this.deps.orders.listFiles(tenantId, actor, id)).map(summarize),
    );
  }
  /**
   * Stores the upload and links it to the order. The caller, the status and the version are checked
   * before any byte is stored, and the link is made by the same actor that uploaded the file.
   */
  public uploadFile(
    token: string,
    correlationId: string,
    id: string,
    input: unknown,
  ): Promise<WorkOrderApiResponse<WorkOrderView>> {
    return this.run(token, correlationId, async (tenantId, actor, viewCosts) => {
      const data = input as Record<string, unknown> | null;
      if (
        typeof data !== 'object' ||
        data === null ||
        Array.isArray(data) ||
        Object.keys(data).some(
          (key) => !['version', 'kind', 'name', 'contentType', 'contentBase64'].includes(key),
        )
      )
        return bad();
      const { version, kind, name, contentType, contentBase64 } = data;
      if (
        typeof name !== 'string' ||
        name.length === 0 ||
        name.length > 200 ||
        typeof contentType !== 'string' ||
        typeof contentBase64 !== 'string' ||
        contentBase64.length === 0 ||
        contentBase64.length % 4 !== 0 ||
        !BASE64.test(contentBase64)
      )
        return bad();
      const fileKind = (['evidence', 'invoice'] as const).find((value) => value === kind);
      if (!fileKind) return bad();
      const bytes = Buffer.from(contentBase64, 'base64');
      if (bytes.length === 0 || bytes.length > MAX_FILE_BYTES) return bad();
      await this.deps.orders.prepareFileChange(tenantId, actor, id, fileKind, version);
      const stored = await this.deps.files.ingest(tenantId, actor.id, correlationId, {
        name,
        contentType,
        bytes,
      });
      const order = await this.deps.orders.attachFile(tenantId, actor, id, {
        version,
        kind: fileKind,
        fileId: stored.id,
      });
      return workOrderView(order, viewCosts);
    });
  }
  public detachFile(
    token: string,
    correlationId: string,
    id: string,
    attachmentId: string,
    input: unknown,
  ): Promise<WorkOrderApiResponse<WorkOrderView>> {
    return this.view(token, correlationId, (tenantId, actor) =>
      this.deps.orders.detachFile(tenantId, actor, id, {
        ...(input as Record<string, unknown>),
        attachmentId,
      }),
    );
  }
  public fileContent(
    token: string,
    correlationId: string,
    id: string,
    attachmentId: string,
  ): Promise<WorkOrderApiResponse<WorkOrderFileContent>> {
    return this.run(token, correlationId, async (tenantId, actor) => {
      const link = await this.deps.orders.fileLink(tenantId, actor, id, attachmentId);
      const bytes = await this.deps.files.read(token, correlationId, link.fileId);
      return {
        displayName: link.displayName,
        contentType: link.contentType,
        contentBase64: Buffer.from(bytes).toString('base64'),
      };
    });
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
