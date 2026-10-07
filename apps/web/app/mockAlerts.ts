import type { ApiError } from '@opslog/contracts';
import {
  BFF_ALERT_RECIPIENT_ROLES,
  BFF_ALERT_SEVERITIES,
  BFF_ALERT_SOURCES,
} from '@opslog/contracts';
import { OPAQUE_ID } from '../documents/rules';
import type {
  Alert,
  AlertListQuery,
  AlertPage,
  AlertRecipientRole,
  AlertSettings,
  AlertsPort,
  Document,
  InsurancePolicy,
  Result,
} from './types';

/**
 * In-memory expiry alerts and alert settings with the semantics of the real backend (`packages/domain/alerts`,
 * `packages/domain/settings`): alerts are derived on every read from the live vehicle documents and the live insurance
 * policies of the company as of the server clock (never stored), `expiring` runs from today to `windowDays` ahead
 * (both ends inclusive) and `expired` is every earlier day; ordered by due date, source and id. The settings carry an
 * optimistic version (0 while never saved: the first save sends 0) and a lost race is a 409 `stale_version`. Permissions
 * of the operations themselves are enforced by the caller (`mockApi`).
 */
export interface MockAlertsStore {
  readonly port: AlertsPort;
  /** Another actor saves new settings on the server: the version moves on, so a form that loaded them is stale. */
  changeSettingsExternally(change: Partial<Pick<AlertSettings, 'expiryWindowDays'>>): void;
  /** The settings as stored, for assertions. */
  settings(): AlertSettings;
}

const NOW = '2026-10-06T12:00:00.000Z';
const DAY_MS = 86_400_000;
export const DEFAULT_WINDOW_DAYS = 30;
export const DEFAULT_RECIPIENTS: readonly AlertRecipientRole[] = ['admin', 'editor'];
const MAX_ALERT_OFFSET = 2_000;
let correlation = 0;

function failure(status: ApiError['status'], code: string, message: string): Result<never> {
  correlation += 1;
  return {
    ok: false,
    error: { code, status, message, correlationId: `corr-mock-alert-${correlation}` },
  };
}
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const badRequest = () => failure(400, 'bad_request', 'Invalid request');

const canonical = (roles: readonly AlertRecipientRole[]): AlertRecipientRole[] =>
  BFF_ALERT_RECIPIENT_ROLES.filter((role) => roles.includes(role));

const daysUntil = (day: string, today: string): number =>
  Math.round((Date.parse(`${day}T00:00:00.000Z`) - Date.parse(`${today}T00:00:00.000Z`)) / DAY_MS);

export function createMockAlertsStore(options: {
  documents: () => readonly Document[];
  policies: () => readonly InsurancePolicy[];
  now?: () => Date;
  actorId?: () => string;
}): MockAlertsStore {
  const now = options.now ?? (() => new Date(NOW));
  const actorId = options.actorId ?? (() => 'user-admin');
  let stored: AlertSettings = {
    expiryWindowDays: DEFAULT_WINDOW_DAYS,
    recipientRoles: DEFAULT_RECIPIENTS,
    version: 0,
    updatedBy: null,
    updatedAt: null,
  };

  const derive = (): Alert[] => {
    const today = now().toISOString().slice(0, 10);
    const rows: Alert[] = [];
    const push = (
      source: Alert['source'],
      subjectId: string,
      vehicleId: string,
      typeCode: string,
      dueOn: string,
    ) => {
      const daysToExpiry = daysUntil(dueOn, today);
      if (daysToExpiry > stored.expiryWindowDays) return;
      rows.push({
        key: `${source}:${subjectId}:${dueOn}`,
        source,
        subjectId,
        vehicleId,
        typeCode,
        dueOn,
        daysToExpiry,
        severity: daysToExpiry < 0 ? 'expired' : 'expiring',
      });
    };
    for (const document of options.documents())
      if (
        document.ownerType === 'vehicle' &&
        document.archivedAt === null &&
        document.expiresOn !== null
      )
        push(
          'vehicle_document',
          document.id,
          document.ownerId,
          document.typeCode,
          document.expiresOn,
        );
    for (const policy of options.policies())
      if (policy.archivedAt === null)
        push('insurance_policy', policy.id, policy.vehicleId, policy.coverageType, policy.endsOn);
    return rows.sort((a, b) =>
      a.dueOn !== b.dueOn
        ? a.dueOn < b.dueOn
          ? -1
          : 1
        : a.source !== b.source
          ? a.source < b.source
            ? -1
            : 1
          : a.subjectId < b.subjectId
            ? -1
            : 1,
    );
  };

  const port: AlertsPort = {
    list: async (query: AlertListQuery = {}) => {
      const limit = query.limit ?? 25;
      const offset =
        query.cursor === undefined ? 0 : Number(/^mock:(\d+)$/.exec(query.cursor)?.[1]);
      if (
        ![25, 50, 100].includes(limit) ||
        !Number.isSafeInteger(offset) ||
        offset > MAX_ALERT_OFFSET ||
        (query.source !== undefined && !BFF_ALERT_SOURCES.includes(query.source)) ||
        (query.severity !== undefined && !BFF_ALERT_SEVERITIES.includes(query.severity)) ||
        (query.vehicleId !== undefined && !OPAQUE_ID.test(query.vehicleId))
      )
        return badRequest();
      const matches = derive().filter(
        (alert) =>
          (query.source === undefined || alert.source === query.source) &&
          (query.severity === undefined || alert.severity === query.severity) &&
          (query.vehicleId === undefined || alert.vehicleId === query.vehicleId),
      );
      const next = offset + limit;
      const page: AlertPage = {
        items: matches.slice(offset, next),
        nextCursor: next < matches.length && next <= MAX_ALERT_OFFSET ? `mock:${next}` : null,
        total: matches.length,
        sort: { field: 'dueOn', direction: 'asc' },
        asOf: now().toISOString().slice(0, 10),
        windowDays: stored.expiryWindowDays,
      };
      return ok(page);
    },
    settings: async () => ok(stored),
    saveSettings: async (input) => {
      const fields = input as unknown as Readonly<Record<string, unknown>>;
      const { version, expiryWindowDays, recipientRoles } = fields;
      const keys = Object.keys(fields);
      if (
        keys.length !== 3 ||
        !['version', 'expiryWindowDays', 'recipientRoles'].every((key) => keys.includes(key)) ||
        typeof version !== 'number' ||
        !Number.isInteger(version) ||
        version < 0 ||
        typeof expiryWindowDays !== 'number' ||
        !Number.isInteger(expiryWindowDays) ||
        expiryWindowDays < 1 ||
        expiryWindowDays > DEFAULT_WINDOW_DAYS ||
        !Array.isArray(recipientRoles) ||
        recipientRoles.length < 1 ||
        recipientRoles.some((role) => !BFF_ALERT_RECIPIENT_ROLES.includes(role)) ||
        new Set(recipientRoles).size !== recipientRoles.length
      )
        return badRequest();
      if (version !== stored.version) return failure(409, 'stale_version', 'Conflict');
      stored = {
        expiryWindowDays,
        recipientRoles: canonical(recipientRoles as AlertRecipientRole[]),
        version: stored.version + 1,
        updatedBy: actorId(),
        updatedAt: NOW,
      };
      return ok(stored);
    },
  };

  return {
    port,
    changeSettingsExternally: (change) => {
      stored = {
        ...stored,
        ...change,
        version: stored.version + 1,
        updatedBy: 'user-sintetico-01',
        updatedAt: NOW,
      };
    },
    settings: () => stored,
  };
}
