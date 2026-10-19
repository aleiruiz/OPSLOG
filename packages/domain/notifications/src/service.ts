import { holds, kindsFor, meets } from './access.js';
import {
  EVENT_KINDS,
  KINDS,
  isEventKind,
  isSubscriptionType,
  type EventKind,
  type SubscriptionType,
} from './catalog.js';
import { NotificationError } from './errors.js';
import type { EntityVisibility, MemberAccess, NotificationStore } from './ports.js';
import { defaultRule, parseEmailKinds } from './rules.js';
import {
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  type CompanyRule,
  type FailedDelivery,
  type Notification,
  type NotificationSlice,
  type Preference,
  type Subscription,
} from './types.js';

/** The person asking, as the API established it from the session. */
export interface NotificationActor {
  readonly tenantId: string;
  /** Identity subject. */
  readonly recipientId: string;
  readonly access: MemberAccess;
}

export interface PreferenceRow {
  readonly eventKind: EventKind;
  readonly label: string;
  readonly description: string;
  /** Fixed: the person cannot switch it off. */
  readonly mandatory: boolean;
  readonly inApp: boolean;
  readonly email: boolean;
  /** The company lets this kind be e-mailed (and this module sends it). */
  readonly emailAvailable: boolean;
}

export interface ListQuery {
  readonly unreadOnly?: unknown;
  readonly kind?: unknown;
  readonly limit?: unknown;
  readonly offset?: unknown;
}

const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const isCount = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

export interface NotificationServiceDeps {
  readonly store: NotificationStore;
  readonly visibility: EntityVisibility;
  readonly now: () => Date;
}

/**
 * What a person does with their notifications: read them, mark them read, choose their channels,
 * follow vehicles and incidents. Everything is scoped to the company and the person of the session;
 * a notice of a kind the person may no longer see stays hidden even though it exists.
 */
export class NotificationService {
  public constructor(private readonly deps: NotificationServiceDeps) {}

  public async list(
    actor: NotificationActor,
    query: ListQuery = {},
  ): Promise<NotificationSlice & { readonly unread: number }> {
    const limit = query.limit ?? DEFAULT_LIST_LIMIT;
    const offset = query.offset ?? 0;
    if (!isCount(limit, 1, MAX_LIST_LIMIT) || !isCount(offset, 0, 100_000))
      throw new NotificationError('invalid_input', 'limit');
    if (query.kind !== undefined && !isEventKind(query.kind))
      throw new NotificationError('invalid_input', 'kind');
    if (query.unreadOnly !== undefined && typeof query.unreadOnly !== 'boolean')
      throw new NotificationError('invalid_input', 'unreadOnly');
    const kinds = kindsFor(actor.access);
    const slice = await this.deps.store.list(
      actor.tenantId,
      actor.recipientId,
      {
        kinds,
        ...(query.kind === undefined ? {} : { kind: query.kind }),
        ...(query.unreadOnly === true ? { unreadOnly: true } : {}),
      },
      { limit, offset },
    );
    return { ...slice, unread: await this.unread(actor) };
  }

  public unread(actor: NotificationActor): Promise<number> {
    return this.deps.store.unread(actor.tenantId, actor.recipientId, kindsFor(actor.access));
  }

  /** Marks one notice read. Another person's notice, or one that does not exist, is not found. */
  public async markRead(actor: NotificationActor, id: string): Promise<Notification> {
    if (!OPAQUE.test(id)) throw new NotificationError('not_found');
    const found = await this.deps.store.find(actor.tenantId, actor.recipientId, id);
    if (!found || !kindsFor(actor.access).includes(found.eventKind))
      throw new NotificationError('not_found');
    await this.deps.store.markRead(
      actor.tenantId,
      actor.recipientId,
      [id],
      kindsFor(actor.access),
      this.deps.now().toISOString(),
    );
    return (await this.deps.store.find(actor.tenantId, actor.recipientId, id)) ?? found;
  }

  public markAllRead(actor: NotificationActor): Promise<number> {
    return this.deps.store.markRead(
      actor.tenantId,
      actor.recipientId,
      null,
      kindsFor(actor.access),
      this.deps.now().toISOString(),
    );
  }

  /** The matrix of kinds by channel for this person: the mandatory ones fixed on. */
  public async preferences(actor: NotificationActor): Promise<readonly PreferenceRow[]> {
    const { store } = this.deps;
    const saved = await store.preferences(actor.tenantId, actor.recipientId);
    const rule = (await store.rule(actor.tenantId)) ?? defaultRule();
    return EVENT_KINDS.filter((kind) => meets(actor.access, KINDS[kind].requires)).map((kind) => {
      const spec = KINDS[kind];
      const choice = saved.find((item) => item.eventKind === kind);
      return {
        eventKind: kind,
        label: spec.label,
        description: spec.description,
        mandatory: spec.mandatory,
        inApp: spec.mandatory || (choice?.inApp ?? true),
        email: spec.email && (spec.mandatory || (choice?.email ?? true)),
        emailAvailable: spec.email && rule.emailKinds.includes(kind),
      };
    });
  }

  /** Saves the choices. A mandatory kind cannot be switched off, and a kind the person cannot see cannot be set. */
  public async savePreferences(
    actor: NotificationActor,
    input: readonly { eventKind: unknown; inApp: unknown; email: unknown }[],
  ): Promise<readonly PreferenceRow[]> {
    if (!Array.isArray(input) || input.length > EVENT_KINDS.length)
      throw new NotificationError('invalid_input', 'preferences');
    const seen = new Set<string>();
    const rows: Preference[] = [];
    for (const item of input) {
      const kind: unknown = item?.eventKind;
      if (
        typeof item !== 'object' ||
        !isEventKind(kind) ||
        typeof item.inApp !== 'boolean' ||
        typeof item.email !== 'boolean' ||
        seen.has(kind) ||
        !meets(actor.access, KINDS[kind].requires)
      )
        throw new NotificationError('invalid_input', 'preferences');
      seen.add(kind);
      const spec = KINDS[kind];
      if (spec.mandatory && (!item.inApp || (spec.email && !item.email)))
        throw new NotificationError('mandatory', kind);
      rows.push({ eventKind: kind, inApp: item.inApp, email: item.email });
    }
    await this.deps.store.savePreferences(
      actor.tenantId,
      actor.recipientId,
      rows,
      this.deps.now().toISOString(),
    );
    return this.preferences(actor);
  }

  /** Follows a vehicle or an incident the person can see. */
  public async subscribe(
    actor: NotificationActor,
    type: unknown,
    entityId: unknown,
  ): Promise<Subscription> {
    if (!isSubscriptionType(type) || typeof entityId !== 'string' || !OPAQUE.test(entityId))
      throw new NotificationError('invalid_input', 'entityId');
    if (!(await this.deps.visibility.visible(actor.tenantId, actor.access, type, entityId)))
      throw new NotificationError('not_found');
    const subscription: Subscription = {
      tenantId: actor.tenantId,
      recipientId: actor.recipientId,
      entityType: type,
      entityId,
      createdAt: this.deps.now().toISOString(),
    };
    await this.deps.store.subscribe(subscription);
    return subscription;
  }

  public async unsubscribe(actor: NotificationActor, type: unknown, entityId: unknown) {
    if (!isSubscriptionType(type) || typeof entityId !== 'string' || !OPAQUE.test(entityId))
      throw new NotificationError('invalid_input', 'entityId');
    await this.deps.store.unsubscribe(actor.tenantId, actor.recipientId, type, entityId);
  }

  /** What the person follows and still sees: a follow of something now out of reach is not listed. */
  public async subscriptions(
    actor: NotificationActor,
    type?: SubscriptionType,
  ): Promise<readonly Subscription[]> {
    const all = await this.deps.store.subscriptionsOf(actor.tenantId, actor.recipientId, type);
    const visible: Subscription[] = [];
    for (const item of all)
      if (
        await this.deps.visibility.visible(
          actor.tenantId,
          actor.access,
          item.entityType,
          item.entityId,
        )
      )
        visible.push(item);
    return visible;
  }

  private assertAdmin(actor: NotificationActor): void {
    if (!holds(actor.access, 'manage_config')) throw new NotificationError('forbidden');
  }

  public async rule(actor: NotificationActor): Promise<CompanyRule> {
    this.assertAdmin(actor);
    return (await this.deps.store.rule(actor.tenantId)) ?? defaultRule();
  }

  public async saveRule(
    actor: NotificationActor,
    input: { readonly emailKinds: unknown; readonly quietHours: unknown },
  ): Promise<CompanyRule> {
    this.assertAdmin(actor);
    if (typeof input.quietHours !== 'boolean')
      throw new NotificationError('invalid_input', 'quietHours');
    const rule: CompanyRule = {
      emailKinds: parseEmailKinds(input.emailKinds),
      quietHours: input.quietHours,
      updatedAt: this.deps.now().toISOString(),
    };
    await this.deps.store.saveRule(actor.tenantId, rule);
    return rule;
  }

  /** Deliveries that ran out of attempts, for the administrator. */
  public async failedDeliveries(
    actor: NotificationActor,
    window: { readonly limit?: unknown; readonly offset?: unknown } = {},
  ): Promise<{ readonly items: readonly FailedDelivery[]; readonly total: number }> {
    this.assertAdmin(actor);
    const limit = window.limit ?? DEFAULT_LIST_LIMIT;
    const offset = window.offset ?? 0;
    if (!isCount(limit, 1, MAX_LIST_LIMIT) || !isCount(offset, 0, 100_000))
      throw new NotificationError('invalid_input', 'limit');
    return this.deps.store.failed(actor.tenantId, { limit, offset });
  }
}
