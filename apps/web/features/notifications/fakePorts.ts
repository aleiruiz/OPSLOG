import type {
  ApiError,
  BffFailedDelivery,
  BffNotification,
  BffNotificationKind,
  BffNotificationPreference,
  BffNotificationRule,
  BffSubscription,
} from '@opslog/contracts';
import { BFF_NOTIFICATION_KINDS } from '@opslog/contracts';
import type { Result } from '../../app/types';
import { kindLabels } from './labels';
import type { NotificationsPorts } from './ports';

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = <T>(status: ApiError['status'], code = 'failure'): Result<T> => ({
  ok: false,
  error: { status, code, message: 'Failure', correlationId: 'corr-fake' },
});

/** Kinds a person cannot switch off. */
const MANDATORY: readonly BffNotificationKind[] = [
  'export_ready',
  'export_failed',
  'membership_role_changed',
];

const NOW = '2026-10-19T16:00:00.000Z';

export const DEMO_NOTIFICATIONS: readonly BffNotification[] = [
  {
    id: 'n-1',
    eventKind: 'incident_sla',
    entityType: 'incident',
    entityId: 'inc-1',
    title: 'El siniestro SIN-0001 está por vencer su plazo de atención',
    link: '/incidents/inc-1',
    severity: 'critical',
    createdAt: '2026-10-19T15:30:00.000Z',
    readAt: null,
  },
  {
    id: 'n-2',
    eventKind: 'document_expiring',
    entityType: 'vehicle',
    entityId: 'veh-1',
    title: 'La verificación del vehículo ECO-001 vence en 15 días',
    link: '/flota/vehiculos/veh-1',
    severity: 'attention',
    createdAt: '2026-10-19T09:00:00.000Z',
    readAt: null,
  },
  {
    id: 'n-3',
    eventKind: 'export_ready',
    entityType: 'export',
    entityId: 'exp-1',
    title: 'Tu exportación «Conductores» está lista',
    link: '/analisis/reportes',
    severity: 'info',
    createdAt: '2026-10-18T12:00:00.000Z',
    readAt: '2026-10-18T12:05:00.000Z',
  },
];

export interface FakeNotifications extends NotificationsPorts {
  readonly calls: { name: string; args: readonly unknown[] }[];
  items: BffNotification[];
  rules: BffNotificationRule;
  failed: BffFailedDelivery[];
  followed: BffSubscription[];
  failNext(operation: keyof NotificationsPorts, status: number): void;
}

/** In-memory notification center for tests and the demo API: reads, pages and saves like the BFF. */
export function createFakeNotifications(
  options: { items?: readonly BffNotification[]; admin?: boolean } = {},
): FakeNotifications {
  const failures = new Map<string, number>();
  const calls: FakeNotifications['calls'] = [];
  const preferences = new Map<string, { inApp: boolean; email: boolean }>();
  const guard = <T>(name: string, ...args: unknown[]): Result<T> | null => {
    calls.push({ name, args });
    const status = failures.get(name);
    if (status === undefined) return null;
    failures.delete(name);
    return fail<T>(status as ApiError['status']);
  };
  const admin = options.admin ?? true;
  const rowOf = (kind: BffNotificationKind): BffNotificationPreference => {
    const chosen = preferences.get(kind);
    const mandatory = MANDATORY.includes(kind);
    return {
      eventKind: kind,
      label: kindLabels[kind],
      description: `Aviso: ${kindLabels[kind].toLowerCase()}.`,
      mandatory,
      inApp: mandatory ? true : (chosen?.inApp ?? true),
      email: chosen?.email ?? mandatory,
      emailAvailable: fake.rules.emailKinds.includes(kind),
    };
  };
  const fake: FakeNotifications = {
    calls,
    items: [...(options.items ?? DEMO_NOTIFICATIONS)],
    rules: {
      emailKinds: ['export_ready', 'export_failed', 'incident_sla'],
      quietHours: false,
      updatedAt: null,
    },
    failed: [],
    followed: [],
    failNext: (operation, status) => void failures.set(operation, status),
    list: async (query = {}) => {
      const failure = guard<never>('list', query);
      if (failure) return failure;
      const matching = fake.items.filter(
        (item) =>
          (query.unread !== 'true' || item.readAt === null) &&
          (!query.kind || item.eventKind === query.kind),
      );
      const offset = query.offset ?? 0;
      const limit = query.limit ?? 25;
      return ok({
        items: matching.slice(offset, offset + limit),
        total: matching.length,
        unread: fake.items.filter((item) => item.readAt === null).length,
        offset,
        limit,
      });
    },
    count: async () =>
      guard('count') ?? ok({ unread: fake.items.filter((item) => item.readAt === null).length }),
    markRead: async (id) => {
      const failure = guard<never>('markRead', id);
      if (failure) return failure;
      const index = fake.items.findIndex((item) => item.id === id);
      const found = fake.items[index];
      if (!found) return fail(404, 'not_found');
      const updated = { ...found, readAt: found.readAt ?? NOW };
      fake.items[index] = updated;
      return ok(updated);
    },
    markAllRead: async () => {
      const failure = guard<never>('markAllRead');
      if (failure) return failure;
      let changed = 0;
      fake.items = fake.items.map((item) => {
        if (item.readAt !== null) return item;
        changed += 1;
        return { ...item, readAt: NOW };
      });
      return ok({ changed });
    },
    preferences: async () =>
      guard('preferences') ?? ok({ items: BFF_NOTIFICATION_KINDS.map(rowOf) }),
    savePreferences: async (input) => {
      const failure = guard<never>('savePreferences', input);
      if (failure) return failure;
      if (input.items.some((row) => MANDATORY.includes(row.eventKind) && !row.inApp))
        return fail(422, 'rule_violation');
      for (const row of input.items)
        preferences.set(row.eventKind, { inApp: row.inApp, email: row.email });
      return ok({ items: BFF_NOTIFICATION_KINDS.map(rowOf) });
    },
    subscriptions: async (type) =>
      guard('subscriptions', type) ??
      ok({ items: fake.followed.filter((item) => !type || item.entityType === type) }),
    subscribe: async (type, entityId) => {
      const failure = guard<never>('subscribe', type, entityId);
      if (failure) return failure;
      const existing = fake.followed.find(
        (item) => item.entityType === type && item.entityId === entityId,
      );
      if (existing) return ok(existing);
      const created = { entityType: type, entityId, createdAt: NOW };
      fake.followed.push(created);
      return ok(created);
    },
    unsubscribe: async (type, entityId) => {
      const failure = guard<never>('unsubscribe', type, entityId);
      if (failure) return failure;
      fake.followed = fake.followed.filter(
        (item) => !(item.entityType === type && item.entityId === entityId),
      );
      return ok(undefined);
    },
    rule: async () => guard('rule') ?? (admin ? ok(fake.rules) : fail(403, 'forbidden')),
    saveRule: async (input) => {
      const failure = guard<never>('saveRule', input);
      if (failure) return failure;
      if (!admin) return fail(403, 'forbidden');
      fake.rules = { ...input, updatedAt: NOW };
      return ok(fake.rules);
    },
    failedDeliveries: async () =>
      guard('failedDeliveries') ??
      (admin
        ? ok({ items: fake.failed, total: fake.failed.length, offset: 0, limit: 25 })
        : fail(403, 'forbidden')),
  };
  return fake;
}
