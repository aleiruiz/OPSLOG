import type {
  ApiError,
  BffIncident,
  BffIncidentInput,
  BffIncidentSuggestions,
  Page,
} from '@opslog/contracts';
import type { Result } from '../../app/types';
import {
  fail,
  isFailure,
  ok,
  omit,
  read,
  type FakeContext,
  type Record_,
  type Setting,
} from './fakeContext';
import { createFakeChildren } from './fakeChildren';
import { createFakeUpdates } from './fakeUpdates';
import { FAKE_NOW, ME, baseIncident } from './fakeIncident';
import {
  FAKE_TRANSITIONS,
  fakeEditableFields,
  fakeMayRun,
  fakeMissing,
  type FakeFacts,
} from './fakeRules';
import type { IncidentPorts } from './ports';
import { INCIDENT_COMMANDS, type Writable } from './types';

export { baseIncident, completeEvent, ME } from './fakeIncident';

export interface FakeIncidentOptions {
  readonly incidents?: readonly BffIncident[];
  readonly permissions?: Setting<readonly string[]>;
  readonly userId?: Setting<string>;
  readonly viewPii?: Setting<boolean>;
  readonly thresholdConfigured?: Setting<boolean>;
  /** D20: what the company bears is above the threshold, so closing needs an approval. */
  readonly approvalRequired?: Setting<boolean>;
  readonly suggestions?: BffIncidentSuggestions;
  readonly vehicles?: readonly BffIncident['vehicle'][];
}

const ALL_ADMIN = [
  'incidents:view',
  'incidents:create',
  'incidents:edit',
  'incidents:report',
  'incidents:approve',
  'incidents:close',
  'incidents:reopen',
  'incidents:view_costs',
];

/**
 * In-memory stand-in for the accepted INC-CASES and INC-WORKFLOW routes, for component tests and the shell
 * mock only. It mimics the server's answers (editable fields, allowed commands, 409, 422 lists, sealed
 * third-party identity); the real server stays the authority.
 */
export function createFakeIncidentPorts(options: FakeIncidentOptions = {}) {
  const records = new Map<string, Record_>();
  const keyed = new Map<string, { body: string; incident: BffIncident }>();
  const calls: string[] = [];
  const failures = new Map<string, Result<never>>();
  let sequence = 0;
  const permissions = () => read(options.permissions ?? ALL_ADMIN);
  const userId = () => read(options.userId ?? ME.id);
  const seed = (incident: BffIncident) =>
    records.set(incident.id, {
      incident: structuredClone(incident),
      timeline: [],
      parties: [],
      evidence: [],
    });
  for (const incident of options.incidents ?? []) seed(incident);

  const injected = (name: string): Result<never> | null => {
    calls.push(name);
    const failure = failures.get(name);
    if (!failure) return null;
    failures.delete(name);
    return failure;
  };
  const visible = (id: string): Record_ | null =>
    permissions().includes('incidents:view') ? (records.get(id) ?? null) : null;

  const facts = (record: Record_): FakeFacts => ({
    cleanPhoto: record.evidence.some(
      (item) => item.category === 'photo' && item.fileStatus === 'clean',
    ),
    cleanCategories: record.evidence
      .filter((item) => item.fileStatus === 'clean')
      .map((item) => item.category),
    pendingFiles: record.evidence.some((item) => item.fileStatus === 'pending_scan'),
    thresholdConfigured: read(options.thresholdConfigured ?? false),
    approvalRequired: read(options.approvalRequired ?? false),
  });
  const view = (record: Record_): BffIncident => {
    const { incident } = record;
    const canEdit =
      permissions().includes('incidents:edit') ||
      (permissions().includes('incidents:report') &&
        incident.status === 'draft' &&
        incident.createdBy.id === userId());
    return {
      ...incident,
      editableFields: canEdit ? fakeEditableFields(incident.status) : [],
      allowedCommands: INCIDENT_COMMANDS.filter(
        (command) =>
          FAKE_TRANSITIONS[command].from.includes(incident.status) &&
          fakeMayRun(permissions(), incident, userId(), command),
      ),
    };
  };
  const writable = (record: Record_): boolean => view(record).editableFields.length > 0;
  const entry = (
    record: Record_,
    command: string,
    changed: string[],
    comment: string | null = null,
  ) => {
    const { incident } = record;
    record.timeline.push({
      sequence: record.timeline.length + 1,
      command,
      from: incident.status,
      to: incident.status,
      actor: ME,
      comment,
      occurredAt: FAKE_NOW,
      changedFields: changed,
      before: null,
    });
  };
  const commit = (record: Record_, changes: Writable<BffIncident>): BffIncident => {
    record.incident = { ...record.incident, ...changes, version: record.incident.version + 1 };
    return view(record);
  };
  /** Version check shared by every write: closed/cancelled answer 409, then a stale version 409. */
  const guard = (id: string, version: number): Record_ | Result<never> => {
    const record = visible(id);
    if (!record) return fail(404, 'not_found');
    if (!writable(record))
      return fail(
        permissions().includes('incidents:view') &&
          view(record).editableFields.length === 0 &&
          record.incident.status !== 'closed' &&
          record.incident.status !== 'cancelled'
          ? 403
          : 409,
        record.incident.status === 'closed' || record.incident.status === 'cancelled'
          ? 'invalid_transition'
          : 'forbidden',
      );
    if (record.incident.version !== version) return fail(409, 'stale_version');
    return record;
  };

  const context: FakeContext = {
    injected,
    visible,
    guard,
    commit,
    entry,
    viewPii: () => read(options.viewPii ?? false),
  };
  const children = { ...createFakeChildren(context), ...createFakeUpdates(context) };

  const ports: IncidentPorts = {
    list: (query) => {
      const failed = injected('list');
      if (failed) return Promise.resolve(failed);
      if (!permissions().includes('incidents:view')) return Promise.resolve(fail(403, 'forbidden'));
      const statuses = query?.status?.split(',');
      const items = [...records.values()]
        .map(view)
        .filter((item) => !statuses || statuses.includes(item.status))
        .filter((item) => !query?.severity || item.severity === query.severity)
        .filter((item) => query?.responsible !== 'me' || item.responsible?.id === userId())
        .filter((item) => query?.createdBy !== 'me' || item.createdBy.id === userId());
      const start = query?.cursor ? Number(query.cursor) : 0;
      const size = query?.limit ?? 25;
      const next = start + size;
      const page: Page<BffIncident> = {
        items: items.slice(start, next),
        nextCursor: next < items.length ? String(next) : null,
        total: items.length,
        sort: { field: 'occurredAt', direction: 'desc' },
      };
      return Promise.resolve(ok(page));
    },
    get: (id) => {
      const failed = injected('get');
      if (failed) return Promise.resolve(failed);
      const record = visible(id);
      return Promise.resolve(record ? ok(view(record)) : fail(404, 'not_found'));
    },
    create: (body: BffIncidentInput, key) => {
      const failed = injected('create');
      if (failed) return Promise.resolve(failed);
      if (
        !permissions().includes('incidents:create') &&
        !permissions().includes('incidents:report')
      )
        return Promise.resolve(fail(403, 'forbidden'));
      const signature = JSON.stringify(body);
      const earlier = keyed.get(key);
      if (earlier)
        return Promise.resolve(
          earlier.body === signature ? ok(earlier.incident) : fail(409, 'idempotency_conflict'),
        );
      const vehicle = (options.vehicles ?? [baseIncident().vehicle]).find(
        (item) => item.id === body.vehicleId,
      );
      if (!vehicle) return Promise.resolve(fail(404, 'not_found'));
      sequence += 1;
      const incident = baseIncident({
        id: `inc-new-${sequence}`,
        folio: `SIN-2026-${String(900 + sequence).padStart(6, '0')}`,
        type: body.type,
        vehicle,
        createdBy: { id: userId(), displayName: ME.displayName },
        ...(body.severity ? { severity: body.severity } : {}),
      });
      seed(incident);
      const created = view(records.get(incident.id) as Record_);
      keyed.set(key, { body: signature, incident: created });
      return Promise.resolve(ok(created));
    },
    update: (id, body) => {
      const failed = injected('update');
      if (failed) return Promise.resolve(failed);
      const record = guard(id, body.version);
      if (isFailure(record)) return Promise.resolve(record);
      const fields = omit(body, 'version');
      const allowed = fakeEditableFields(record.incident.status) as readonly string[];
      if (Object.keys(fields).some((key) => !allowed.includes(key)))
        return Promise.resolve(fail(409, 'invalid_transition'));
      if (fields.occurredAt && Date.parse(fields.occurredAt) > Date.parse(FAKE_NOW))
        return Promise.resolve(
          fail(422, 'rule_violation', {
            fieldErrors: [{ field: 'occurred_at_in_future', code: 'invalid', message: 'x' }],
          }),
        );
      const { driverId, location, damage, ...plain } = omit(fields, 'policyId', 'vehicleId');
      const changes: Writable<BffIncident> = { ...plain } as Partial<BffIncident>;
      if (driverId !== undefined)
        changes.driver =
          driverId === null ? null : { employeeId: driverId, displayName: 'Conductor elegido' };
      if (location !== undefined)
        changes.location =
          location === null ? null : { latitude: null, longitude: null, ...location };
      if (damage !== undefined)
        changes.damage = { description: damage.description ?? null, zones: damage.zones ?? [] };
      if (fields.occurredAt) changes.occurredOn = fields.occurredAt.slice(0, 10);
      entry(record, 'update', Object.keys(fields));
      return Promise.resolve(ok(commit(record, changes)));
    },
    suggestions: () => {
      const failed = injected('suggestions');
      if (failed) return Promise.resolve(failed);
      return Promise.resolve(
        ok(
          options.suggestions ?? {
            drivers: [],
            policies: [],
            coverage: { status: 'unknown', alert: null },
          },
        ),
      );
    },
    timeline: (id) => {
      const failed = injected('timeline');
      if (failed) return Promise.resolve(failed);
      const record = visible(id);
      return Promise.resolve(
        record ? ok({ items: [...record.timeline].reverse() }) : fail(404, 'not_found'),
      );
    },
    nextSteps: (id) => {
      const failed = injected('nextSteps');
      if (failed) return Promise.resolve(failed);
      const record = visible(id);
      if (!record) return Promise.resolve(fail(404, 'not_found'));
      const current = view(record);
      return Promise.resolve(
        ok({
          items: current.allowedCommands.map((command) => ({
            command,
            missingRequirements: fakeMissing(command, current, facts(record)),
          })),
        }),
      );
    },
    transition: (id, body) => {
      const failed = injected('transition');
      if (failed) return Promise.resolve(failed);
      const record = visible(id);
      if (!record) return Promise.resolve(fail(404, 'not_found'));
      const current = view(record);
      if (!fakeMayRun(permissions(), current, userId(), body.command))
        return Promise.resolve(fail(403, 'forbidden'));
      const rule = FAKE_TRANSITIONS[body.command];
      if (!rule.from.includes(current.status))
        return Promise.resolve(fail(409, 'invalid_transition'));
      if (current.version !== body.version) return Promise.resolve(fail(409, 'stale_version'));
      const missing = [
        ...(body.command === 'assign' && !body.responsibleId ? ['responsible'] : []),
        ...((body.command === 'cancel' || body.command === 'reopen') && !body.reason?.trim()
          ? ['reason']
          : []),
        ...fakeMissing(body.command, current, facts(record)),
      ];
      if (missing.length > 0)
        return Promise.resolve(fail(422, 'missing_requirements', { missingRequirements: missing }));
      const changes: Writable<BffIncident> = rule.to ? { status: rule.to } : {};
      const stamp = { by: ME, at: FAKE_NOW };
      if (body.command === 'assign')
        changes.responsible = {
          id: body.responsibleId as string,
          displayName: 'Responsable asignado',
        };
      if (body.command === 'report')
        Object.assign(changes, { reportedAt: FAKE_NOW, reportedBy: ME });
      if (body.command === 'approve_close')
        changes.resolution = { ...current.resolution, closeApproval: stamp };
      if (body.command === 'approve_assumption')
        changes.insurance = { ...current.insurance, assumptionApproval: stamp };
      if (body.command === 'close')
        changes.resolution = { ...current.resolution, closedAt: FAKE_NOW, closedBy: ME };
      if (body.command === 'cancel')
        changes.resolution = { ...current.resolution, cancelReason: body.reason ?? null };
      if (body.command === 'reopen')
        changes.resolution = {
          ...current.resolution,
          closedAt: null,
          closedBy: null,
          closeApproval: null,
        };
      record.timeline.push({
        sequence: record.timeline.length + 1,
        command: body.command,
        from: current.status,
        to: rule.to ?? current.status,
        actor: ME,
        comment: body.reason ?? body.comment ?? null,
        occurredAt: FAKE_NOW,
        changedFields: [],
        before: null,
      });
      return Promise.resolve(ok(commit(record, changes)));
    },
    ...children,
  };

  return {
    ports,
    /** Names of the port calls made, in order. */
    calls,
    /** The next call to `operation` (for example `get` or `thirdParties.list`) answers with this failure. */
    failNext(operation: string, status: ApiError['status'], code = 'internal_error') {
      failures.set(operation, fail(status, code));
    },
    /** The malware scan finished: every pending file becomes clean (or rejected). */
    scan(incidentId: string, outcome: 'clean' | 'rejected' = 'clean') {
      const record = records.get(incidentId);
      if (record)
        record.evidence = record.evidence.map((item) =>
          item.fileStatus === 'pending_scan'
            ? { ...item, fileStatus: outcome, counts: outcome === 'clean' }
            : item,
        );
    },
    /** Another person changes the case: the version moves on. */
    changeExternally(incidentId: string, changes: Partial<BffIncident>) {
      const record = records.get(incidentId);
      if (record)
        record.incident = { ...record.incident, ...changes, version: record.incident.version + 1 };
    },
    /** The stored case, without the caller's view. */
    stored(incidentId: string): BffIncident | undefined {
      return records.get(incidentId)?.incident;
    },
  };
}
