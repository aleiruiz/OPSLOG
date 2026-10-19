import type { Permission } from '../../../../packages/domain/identity/src/index.js';
import {
  isSubscriptionType,
  NotificationError,
  type CompanyRule,
  type EventKind,
  type FailedDelivery,
  type Notification,
  type NotificationActor,
  type NotificationService,
  type PreferenceRow,
  type Severity,
  type Subscription,
} from '../../../../packages/domain/notifications/src/index.js';
import { apiFailure, type NotificationsApiResponse } from './failure.js';

export { apiFailure, type NotificationsApiResponse } from './failure.js';

/** What the API needs of the platform: the session, its grants and whether the person is a mechanic. */
export interface NotificationsSession {
  readonly tenantId: string;
  /** Identity subject of the reader. */
  readonly subject: string;
  readonly permissions: readonly string[];
  /** The member has (or had) a mechanic record (D9). */
  readonly mechanicLinked: boolean;
}

export type NotificationsAuthorize = (
  token: string,
  correlationId: string,
) => Promise<NotificationsSession>;

export interface NotificationsApiDeps {
  readonly authorize: NotificationsAuthorize;
  readonly service: NotificationService;
}

/** A notice as the screen gets it: no company, no recipient. */
export interface NotificationView {
  readonly id: string;
  readonly eventKind: EventKind;
  readonly entityType: string;
  readonly entityId: string;
  readonly title: string;
  readonly link: string;
  readonly severity: Severity;
  readonly createdAt: string;
  readonly readAt: string | null;
}

export interface SubscriptionView {
  readonly entityType: string;
  readonly entityId: string;
  readonly createdAt: string;
}

const view = (item: Notification): NotificationView => ({
  id: item.id,
  eventKind: item.eventKind,
  entityType: item.entityType,
  entityId: item.entityId,
  title: item.title,
  link: item.link,
  severity: item.severity,
  createdAt: item.createdAt,
  readAt: item.readAt,
});

const subscriptionView = (item: Subscription): SubscriptionView => ({
  entityType: item.entityType,
  entityId: item.entityId,
  createdAt: item.createdAt,
});

/** Notification center for the signed-in person. Every call is scoped to the company and person of the session. */
export class NotificationsApi {
  public constructor(private readonly deps: NotificationsApiDeps) {}

  private async run<T>(
    token: string,
    correlationId: string,
    work: (actor: NotificationActor) => Promise<T>,
  ): Promise<NotificationsApiResponse<T>> {
    try {
      const session = await this.deps.authorize(token, correlationId);
      return {
        ok: true,
        value: await work({
          tenantId: session.tenantId,
          recipientId: session.subject,
          access: {
            permissions: session.permissions as readonly Permission[],
            mechanicLinked: session.mechanicLinked,
          },
        }),
      };
    } catch (error) {
      return apiFailure(error);
    }
  }

  public list(
    token: string,
    correlationId: string,
    query: { unreadOnly?: unknown; kind?: unknown; limit?: unknown; offset?: unknown } = {},
  ) {
    return this.run(token, correlationId, async (actor) => {
      const slice = await this.deps.service.list(actor, query);
      return { items: slice.items.map(view), total: slice.total, unread: slice.unread };
    });
  }

  public count(token: string, correlationId: string) {
    return this.run(token, correlationId, async (actor) => ({
      unread: await this.deps.service.unread(actor),
    }));
  }

  public markRead(token: string, correlationId: string, id: string) {
    return this.run(token, correlationId, async (actor) =>
      view(await this.deps.service.markRead(actor, id)),
    );
  }

  public markAllRead(token: string, correlationId: string) {
    return this.run(token, correlationId, async (actor) => ({
      changed: await this.deps.service.markAllRead(actor),
    }));
  }

  public preferences(token: string, correlationId: string) {
    return this.run(token, correlationId, async (actor) => ({
      items: await this.deps.service.preferences(actor),
    }));
  }

  public savePreferences(token: string, correlationId: string, items: unknown) {
    return this.run(token, correlationId, async (actor) => ({
      items: await this.deps.service.savePreferences(
        actor,
        items as Parameters<NotificationService['savePreferences']>[1],
      ),
    }));
  }

  public subscriptions(token: string, correlationId: string, type?: string) {
    return this.run(token, correlationId, async (actor) => {
      if (type !== undefined && !isSubscriptionType(type))
        throw new NotificationError('invalid_input', 'type');
      const items = await this.deps.service.subscriptions(actor, type);
      return { items: items.map(subscriptionView) };
    });
  }

  public subscribe(token: string, correlationId: string, type: unknown, entityId: unknown) {
    return this.run(token, correlationId, async (actor) =>
      subscriptionView(await this.deps.service.subscribe(actor, type, entityId)),
    );
  }

  public unsubscribe(token: string, correlationId: string, type: unknown, entityId: unknown) {
    return this.run(token, correlationId, async (actor) => {
      await this.deps.service.unsubscribe(actor, type, entityId);
      return { removed: true as const };
    });
  }

  public rule(token: string, correlationId: string) {
    return this.run(token, correlationId, (actor) => this.deps.service.rule(actor));
  }

  public saveRule(
    token: string,
    correlationId: string,
    input: { emailKinds?: unknown; quietHours?: unknown },
  ) {
    return this.run(token, correlationId, (actor) =>
      this.deps.service.saveRule(actor, {
        emailKinds: input.emailKinds,
        quietHours: input.quietHours,
      }),
    );
  }

  public failedDeliveries(
    token: string,
    correlationId: string,
    window: { limit?: unknown; offset?: unknown } = {},
  ) {
    return this.run(token, correlationId, (actor) =>
      this.deps.service.failedDeliveries(actor, window),
    );
  }
}

export type { CompanyRule, FailedDelivery, PreferenceRow };
