import {
  AuthError,
  type Permission,
  type TenantContext,
} from '../../../../packages/domain/identity/src/index.js';
import {
  MAX_ENDPOINTS,
  WebhookError,
  type DeliveryView,
  type EndpointView,
  type Slice,
  type WebhookService,
} from '../../../../packages/domain/webhooks/src/index.js';

/** Same shape as the composition's responses: a value, or a code with its status and a fixed text. */
export type WebhooksApiResponse<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: string;
        readonly status: number;
        readonly message: string;
        readonly field?: string;
        readonly fieldErrors?: readonly { field: string; code: 'invalid' }[];
        /** Id of the broken business rule of a 422. */
        readonly rule?: string;
      };
    };

const STATUS: Readonly<Record<string, number>> = {
  invalid_input: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  stale_version: 409,
  invalid_transition: 409,
  rule_violation: 422,
  internal_error: 500,
};

function codeOf(error: unknown): string {
  if (error instanceof WebhookError)
    return error.code === 'limit_reached' ? 'rule_violation' : error.code;
  if (error instanceof AuthError)
    return error.code === 'expired' || error.code === 'unauthorized'
      ? 'unauthorized'
      : error.code === 'forbidden'
        ? 'forbidden'
        : error.code === 'invalid_input'
          ? 'invalid_input'
          : 'internal_error';
  return 'internal_error';
}

/** Any failure becomes a code, its status and a fixed text: no URL, secret or store message. */
export function apiFailure(error: unknown): WebhooksApiResponse<never> {
  const code = codeOf(error);
  const field = error instanceof WebhookError ? error.field : undefined;
  return {
    ok: false,
    error: {
      code,
      status: STATUS[code] ?? 500,
      message: code === 'internal_error' ? 'Request failed' : `Webhooks request rejected: ${code}`,
      ...(code === 'invalid_input' && field
        ? { fieldErrors: [{ field, code: 'invalid' as const }] }
        : {}),
      ...(code === 'rule_violation' && error instanceof WebhookError ? { rule: error.code } : {}),
    },
  };
}

export type WebhookAuditAction =
  | 'webhook.endpoint_created'
  | 'webhook.endpoint_updated'
  | 'webhook.secret_rotated'
  | 'webhook.endpoint_deleted'
  | 'webhook.test_sent'
  | 'webhook.delivery_retried';

export interface WebhooksApiDeps {
  /** Authenticates the session and requires every permission; the tenant comes only from it. */
  readonly authorize: (
    token: string,
    correlationId: string,
    required: readonly Permission[],
  ) => Promise<TenantContext>;
  readonly service: WebhookService;
  /** Appends an audit event: the action and the endpoint id only, never a URL or a secret. */
  readonly audit: (
    context: TenantContext,
    action: WebhookAuditAction,
    entityId: string,
    correlationId: string,
  ) => void | Promise<void>;
}

export const WEBHOOK_PERMISSIONS = ['integrations:manage'] as const satisfies readonly Permission[];

export interface CreatedEndpoint {
  readonly endpoint: EndpointView;
  /** Shown once. */
  readonly secret: string;
}

const COUNT = (value: unknown, fallback: number, max: number): number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? Math.min(value, max)
    : fallback;

/**
 * Webhook administration for the HTTP layer. Every call re-resolves the session and requires
 * `integrations:manage` (`manage_config` alone is not enough), takes the company only from the
 * session and audits each change by endpoint id.
 */
export class WebhooksApi {
  public constructor(private readonly deps: WebhooksApiDeps) {}

  private async run<T>(
    token: string,
    correlationId: string,
    work: (context: TenantContext) => Promise<T>,
    audit?: (value: T) => { action: WebhookAuditAction; id: string },
  ): Promise<WebhooksApiResponse<T>> {
    try {
      const context = await this.deps.authorize(token, correlationId, WEBHOOK_PERMISSIONS);
      const value = await work(context);
      const entry = audit?.(value);
      if (entry) await this.deps.audit(context, entry.action, entry.id, correlationId);
      return { ok: true, value };
    } catch (error) {
      return apiFailure(error);
    }
  }

  public list(token: string, correlationId: string) {
    return this.run(token, correlationId, async (c) => ({
      items: await this.deps.service.list(c.tenantId),
      max: MAX_ENDPOINTS,
    }));
  }

  public get(token: string, correlationId: string, id: string) {
    return this.run(token, correlationId, (c) => this.deps.service.get(c.tenantId, id));
  }

  public create(
    token: string,
    correlationId: string,
    input: { url: unknown; events: unknown; active?: unknown },
  ) {
    return this.run<CreatedEndpoint>(
      token,
      correlationId,
      (c) => this.deps.service.create(c.tenantId, c.actor.subject, input),
      (value) => ({ action: 'webhook.endpoint_created', id: value.endpoint.id }),
    );
  }

  public update(
    token: string,
    correlationId: string,
    id: string,
    input: { version: unknown; url?: unknown; events?: unknown; active?: unknown },
  ) {
    return this.run(
      token,
      correlationId,
      (c) => this.deps.service.update(c.tenantId, id, input),
      (value) => ({ action: 'webhook.endpoint_updated', id: value.id }),
    );
  }

  public rotate(token: string, correlationId: string, id: string, version: unknown) {
    return this.run<CreatedEndpoint>(
      token,
      correlationId,
      (c) => this.deps.service.rotate(c.tenantId, id, version),
      (value) => ({ action: 'webhook.secret_rotated', id: value.endpoint.id }),
    );
  }

  public async remove(token: string, correlationId: string, id: string) {
    return this.run<{ id: string }>(
      token,
      correlationId,
      async (c) => {
        await this.deps.service.remove(c.tenantId, id);
        return { id };
      },
      (value) => ({ action: 'webhook.endpoint_deleted', id: value.id }),
    );
  }

  public test(token: string, correlationId: string, id: string) {
    return this.run(
      token,
      correlationId,
      (c) => this.deps.service.test(c.tenantId, id),
      () => ({ action: 'webhook.test_sent', id }),
    );
  }

  public deliveries(
    token: string,
    correlationId: string,
    id: string,
    window: { limit?: number; offset?: number },
  ): Promise<WebhooksApiResponse<Slice<DeliveryView> & { limit: number; offset: number }>> {
    const limit = COUNT(window.limit, 25, 100) || 25;
    const offset = COUNT(window.offset, 0, 1_000_000);
    return this.run(token, correlationId, async (c) => ({
      ...(await this.deps.service.deliveries(c.tenantId, id, { limit, offset })),
      limit,
      offset,
    }));
  }

  public retry(token: string, correlationId: string, id: string, deliveryId: string) {
    return this.run(
      token,
      correlationId,
      (c) => this.deps.service.retry(c.tenantId, id, deliveryId),
      () => ({ action: 'webhook.delivery_retried', id }),
    );
  }
}
