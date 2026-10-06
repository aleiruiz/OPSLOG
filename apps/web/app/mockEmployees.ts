import type { ApiError } from '@opslog/contracts';
import { BFF_EMPLOYEE_KINDS, BFF_EMPLOYEE_STATUSES } from '@opslog/contracts';
import { demoEmployees, FIXTURE_TODAY, type EmployeePiiValues } from '../employees/fixtures';
import {
  EMAIL,
  EMPLOYEE_NUMBER,
  ID_TYPE,
  IDENTIFICATION,
  LABEL,
  LICENSE_NUMBER,
  LICENSE_TYPE,
  MAX_LICENSE_DATE,
  MIN_DATE,
  NAME,
  OPAQUE_ID,
  PHONE,
  canTransition,
  fitnessOf,
  isDateBetween,
  isReasonValid,
  normalizeCode,
  normalizeEmail,
  normalizeName,
  normalizePhone,
  normalizeUpper,
} from '../employees/rules';
import type {
  Employee,
  EmployeeDetail,
  EmployeeHistoryEntry,
  EmployeeInput,
  EmployeeListQuery,
  EmployeePatch,
  EmployeesPort,
  EmployeeStatus,
  Page,
  Result,
} from './types';

/**
 * In-memory employees with the semantics of the real backend (`packages/domain/employees` and the
 * `EmployeesApi` composition): optimistic versions (409 `stale_version`), read-only archived and terminated
 * employees (409 `immutable`), a status matrix (409 `invalid_transition`), per-company uniqueness of employee
 * number, identification and e-mail (409 `duplicate` with the colliding field), an active area of the company
 * (422 `invalid_area`), personal data that only `get` returns and only to a session with `view_pii`, a history of
 * status and area changes, and a uniform 400/404. Operation permissions are enforced by the caller (`mockApi`);
 * the PII permission needed to write personal data is part of that check, like on the server.
 */
export interface MockEmployeeStore {
  readonly port: EmployeesPort;
  /** Another actor changes the employee on the server: bumps its version, so the caller's copy is stale. */
  changeExternally(id: string, change: Partial<Pick<Employee, 'position' | 'firstName'>>): void;
  /** Another actor archives the employee on the server. */
  archiveExternally(id: string): void;
  /** Another actor terminates the employee on the server. */
  terminateExternally(id: string): void;
  /** Employees currently on the server (no personal data), for assertions. */
  snapshot(): readonly Employee[];
  /** Every audit event the server recorded: action and entity id, never a value. */
  auditLog(): readonly { readonly action: EmployeeAuditAction; readonly id: string }[];
  /** Employees of the area that still count as assigned people (BR-021): not archived, not terminated. */
  countLiveInArea(areaId: string): number;
}

export type EmployeeAuditAction =
  | 'employee.created'
  | 'employee.updated'
  | 'employee.status_changed'
  | 'employee.archived'
  | 'employee.pii_viewed';

export interface MockEmployeeEnvironment {
  /** Whether an area id is an active area of the company (like the backend, which refuses any other). */
  readonly isActiveArea: (areaId: string) => boolean;
  /** Whether the signed-in session holds `view_pii`. */
  readonly canViewPii: () => boolean;
  /** The signed-in user, recorded in the history. */
  readonly actorId: () => string;
}

const NOW = '2026-10-06T12:00:00.000Z';
let correlation = 0;

function failure(
  status: ApiError['status'],
  code: string,
  message: string,
  field?: string,
): Result<never> {
  correlation += 1;
  return {
    ok: false,
    error: {
      code,
      status,
      message,
      correlationId: `corr-mock-employee-${correlation}`,
      ...(field === undefined ? {} : { fieldErrors: [{ field, code, message }] }),
    },
  };
}
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const badRequest = () => failure(400, 'bad_request', 'Invalid request');
const notFound = () => failure(404, 'not_found', 'Resource not found');
const invalidArea = () => failure(422, 'invalid_area', 'Unprocessable request', 'area_id');
const conflict = (code: 'stale_version' | 'immutable' | 'invalid_transition') =>
  failure(409, code, 'Conflict');
const duplicate = (field: string) => failure(409, 'duplicate', 'Conflict', field);

const validVersion = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 2_147_483_646;

const CREATE_KEYS = [
  'kind',
  'firstName',
  'lastName',
  'employeeNumber',
  'position',
  'hireDate',
  'areaId',
  'idType',
  'nationalId',
  'phone',
  'email',
  'licenseNumber',
  'licenseType',
  'licenseExpiresOn',
] as const;
const LICENSE_KEYS = ['licenseNumber', 'licenseType', 'licenseExpiresOn'] as const;

type Row = EmployeeDetail & { readonly pii: EmployeePiiValues };

interface Core {
  firstName: string;
  lastName: string;
  employeeNumber: string | null;
  position: string | null;
  hireDate: string | null;
  areaId: string;
  idType: string | null;
  licenseType: string | null;
  licenseExpiresOn: string | null;
}
type Parsed = { core: Partial<Core>; pii: Partial<EmployeePiiValues> };

/** Validates and normalizes the fields that are present; `null` when anything is invalid. */
function parseFields(
  input: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  today: string,
): Parsed | null {
  if (Object.keys(input).some((key) => !allowed.includes(key))) return null;
  const core: { -readonly [K in keyof Core]?: Core[K] } = {};
  const pii: { -readonly [K in keyof EmployeePiiValues]?: string | null } = {};
  const has = (key: string) => Object.hasOwn(input, key);
  const text = (key: string, pattern: RegExp, normalize: (value: string) => string) => {
    const value = input[key];
    if (typeof value !== 'string') return undefined;
    const normalized = normalize(value);
    return pattern.test(normalized) ? normalized : undefined;
  };
  /** `null` clears; otherwise the normalized text, or `false` when invalid. */
  const nullable = (key: string, pattern: RegExp, normalize: (value: string) => string) =>
    input[key] === null ? null : (text(key, pattern, normalize) ?? false);

  for (const key of ['firstName', 'lastName'] as const) {
    if (!has(key)) continue;
    const value = text(key, NAME, normalizeName);
    if (value === undefined) return null;
    core[key] = value;
  }
  if (has('areaId')) {
    const value = input['areaId'];
    if (typeof value !== 'string' || !OPAQUE_ID.test(value)) return null;
    core.areaId = value;
  }
  const simple: [keyof Core, RegExp, (value: string) => string][] = [
    ['employeeNumber', EMPLOYEE_NUMBER, (value) => value.trim()],
    ['position', LABEL, (value) => value.trim()],
    ['licenseType', LICENSE_TYPE, normalizeUpper],
  ];
  for (const [key, pattern, normalize] of simple) {
    if (!has(key)) continue;
    const value = nullable(key, pattern, normalize);
    if (value === false) return null;
    (core as Record<string, unknown>)[key] = value;
  }
  if (has('hireDate')) {
    const value = input['hireDate'];
    if (value !== null && (typeof value !== 'string' || !isDateBetween(value, MIN_DATE, today)))
      return null;
    core.hireDate = value as string | null;
  }
  if (has('licenseExpiresOn')) {
    const value = input['licenseExpiresOn'];
    if (
      value !== null &&
      (typeof value !== 'string' || !isDateBetween(value, MIN_DATE, MAX_LICENSE_DATE))
    )
      return null;
    core.licenseExpiresOn = value as string | null;
  }
  // `idType` and `nationalId` go together (both set or both cleared).
  if (has('idType') || has('nationalId')) {
    if (!has('idType') || !has('nationalId')) return null;
    if ((input['idType'] === null) !== (input['nationalId'] === null)) return null;
    if (input['idType'] === null) {
      core.idType = null;
      pii.nationalId = null;
    } else {
      const idType = text('idType', ID_TYPE, normalizeCode);
      const nationalId = text('nationalId', IDENTIFICATION, normalizeUpper);
      if (idType === undefined || nationalId === undefined) return null;
      core.idType = idType;
      pii.nationalId = nationalId;
    }
  }
  for (const [key, pattern, normalize] of [
    ['phone', PHONE, normalizePhone],
    ['email', EMAIL, normalizeEmail],
    ['licenseNumber', LICENSE_NUMBER, normalizeUpper],
  ] as const) {
    if (!has(key)) continue;
    const value = nullable(key, pattern, normalize);
    if (value === false || (key === 'email' && typeof value === 'string' && value.length > 254))
      return null;
    pii[key] = value;
  }
  return { core, pii };
}

const idKey = (idType: string | null, nationalId: string) =>
  `${idType}:${nationalId.replace(/[ ./-]/g, '')}`;
const sortKey = (employee: Pick<Employee, 'firstName' | 'lastName'>) =>
  `${employee.lastName} ${employee.firstName}`.toLowerCase();
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The demo staff, with a long history on the first employee so the history needs a second page. */
export const demoMockEmployees = (): EmployeeDetail[] =>
  demoEmployees().map((employee) =>
    employee.id === 'emp-001' ? { ...employee, version: 31 } : employee,
  );

export function createMockEmployeeStore(
  env: MockEmployeeEnvironment,
  seed: readonly EmployeeDetail[] = demoMockEmployees(),
  now: () => string = () => NOW,
  today: () => string = () => FIXTURE_TODAY,
): MockEmployeeStore {
  let rows: Row[] = seed.map((employee) => ({
    ...employee,
    pii: {
      ...(employee.pii ?? { nationalId: null, phone: null, email: null, licenseNumber: null }),
    },
  }));
  let sequence = rows.length;
  let historySequence = 0;
  const audit: { action: EmployeeAuditAction; id: string }[] = [];

  const entry = (
    id: string,
    kind: EmployeeHistoryEntry['kind'],
    from: string | null,
    to: string,
    reason: string | null,
    actorId: string,
    version: number,
    at: string,
  ): EmployeeHistoryEntry => {
    historySequence += 1;
    return { id: `hist-mock-${historySequence}`, kind, from, to, reason, actorId, version, at };
  };

  // Every employee starts with a believable history: the hiring and, for long-lived ones, status changes.
  const history = new Map<string, EmployeeHistoryEntry[]>();
  for (const row of rows) {
    const entries = [
      entry(row.id, 'status', null, 'active', 'Alta', 'user-admin', 1, row.createdAt),
    ];
    let state: EmployeeStatus = 'active';
    for (let version = 2; version <= row.version; version += 1) {
      const last = version === row.version;
      const to: EmployeeStatus = last ? row.status : state === 'active' ? 'suspended' : 'active';
      if (to === state) continue;
      entries.push(
        entry(
          row.id,
          'status',
          state,
          to,
          last ? row.statusReason : 'Cambio de estado de demostración',
          'user-admin',
          version,
          last ? row.updatedAt : row.createdAt,
        ),
      );
      state = to;
    }
    history.set(row.id, entries);
  }

  const index = (id: string) => rows.findIndex((employee) => employee.id === id);
  const view = (row: Row): Employee => {
    const { pii, ...rest } = row;
    const piiPresent = {
      nationalId: pii.nationalId !== null,
      phone: pii.phone !== null,
      email: pii.email !== null,
      licenseNumber: pii.licenseNumber !== null,
    };
    return { ...rest, piiPresent, fitness: fitnessOf({ ...rest, piiPresent }, today()) };
  };
  const replace = (next: Row) => {
    rows = rows.map((row) => (row.id === next.id ? next : row));
    return next;
  };
  const record = (id: string, item: EmployeeHistoryEntry) =>
    history.set(id, [...(history.get(id) ?? []), item]);
  const bump = (row: Row, change: Partial<Row>): Row => ({
    ...row,
    ...change,
    version: row.version + 1,
    updatedAt: now(),
  });
  const collision = (candidate: Row): string | null => {
    for (const other of rows) {
      if (other.id === candidate.id) continue;
      if (
        candidate.employeeNumber !== null &&
        other.employeeNumber !== null &&
        other.employeeNumber.toLowerCase() === candidate.employeeNumber.toLowerCase()
      )
        return 'employee_number';
      if (
        candidate.pii.nationalId !== null &&
        other.pii.nationalId !== null &&
        idKey(other.idType, other.pii.nationalId) ===
          idKey(candidate.idType, candidate.pii.nationalId)
      )
        return 'national_id';
      if (candidate.pii.email !== null && other.pii.email === candidate.pii.email) return 'email';
    }
    return null;
  };
  const window = (query: { limit?: number; cursor?: string }) => {
    const limit = query.limit ?? 25;
    const offset = query.cursor === undefined ? 0 : Number(/^mock:(\d+)$/.exec(query.cursor)?.[1]);
    return [25, 50, 100].includes(limit) && Number.isSafeInteger(offset) ? { limit, offset } : null;
  };
  const page = <T>(items: readonly T[], limit: number, offset: number, field: string): Page<T> => {
    const next = offset + limit;
    return {
      items: items.slice(offset, next),
      nextCursor: next < items.length ? `mock:${next}` : null,
      total: items.length,
      sort: { field, direction: field === 'lastName' ? 'asc' : 'desc' },
    };
  };

  const port: EmployeesPort = {
    list: async (query: EmployeeListQuery = {}) => {
      const slice = window(query);
      if (
        !slice ||
        (query.kind !== undefined && !BFF_EMPLOYEE_KINDS.includes(query.kind)) ||
        (query.status !== undefined && !BFF_EMPLOYEE_STATUSES.includes(query.status)) ||
        (query.areaId !== undefined && !OPAQUE_ID.test(query.areaId)) ||
        (query.includeArchived !== undefined && !['true', 'false'].includes(query.includeArchived))
      )
        return badRequest();
      const matches = rows
        .filter(
          (row) =>
            (query.includeArchived === 'true' || row.archivedAt === null) &&
            (query.kind === undefined || row.kind === query.kind) &&
            (query.status === undefined || row.status === query.status) &&
            (query.areaId === undefined || row.areaId === query.areaId),
        )
        .sort((a, b) => compare(sortKey(a), sortKey(b)) || compare(a.id, b.id))
        .map(view);
      return ok(page(matches, slice.limit, slice.offset, 'lastName'));
    },
    get: async (id) => {
      const found = rows[index(id)];
      if (!found) return notFound();
      if (!env.canViewPii()) return ok({ ...view(found), pii: null });
      const pii = { ...found.pii };
      // The disclosure is audited before it is returned; nothing is audited when there is nothing to show.
      if (Object.values(pii).some((value) => value !== null))
        audit.push({ action: 'employee.pii_viewed', id });
      return ok({ ...view(found), pii });
    },
    create: async (input: EmployeeInput) => {
      const fields = input as unknown as Readonly<Record<string, unknown>>;
      const kind = fields['kind'];
      const parsed = parseFields(fields, CREATE_KEYS, today());
      if (
        parsed === null ||
        !BFF_EMPLOYEE_KINDS.includes(kind as never) ||
        ['firstName', 'lastName', 'areaId'].some((key) => !Object.hasOwn(fields, key)) ||
        (kind !== 'driver' && LICENSE_KEYS.some((key) => Object.hasOwn(fields, key)))
      )
        return badRequest();
      const { core, pii } = parsed;
      if (!env.isActiveArea(core.areaId as string)) return invalidArea();
      sequence += 1;
      const at = now();
      const row: Row = {
        id: `emp-nuevo-${sequence}`,
        kind: kind as Row['kind'],
        firstName: core.firstName as string,
        lastName: core.lastName as string,
        employeeNumber: core.employeeNumber ?? null,
        position: core.position ?? null,
        hireDate: core.hireDate ?? null,
        areaId: core.areaId as string,
        status: 'active',
        statusReason: 'Alta',
        idType: core.idType ?? null,
        licenseType: core.licenseType ?? null,
        licenseExpiresOn: core.licenseExpiresOn ?? null,
        pii: {
          nationalId: pii.nationalId ?? null,
          phone: pii.phone ?? null,
          email: pii.email ?? null,
          licenseNumber: pii.licenseNumber ?? null,
        },
        piiPresent: { nationalId: false, phone: false, email: false, licenseNumber: false },
        fitness: null,
        version: 1,
        createdAt: at,
        updatedAt: at,
        archivedAt: null,
      };
      const clash = collision(row);
      if (clash) return duplicate(clash);
      rows = [...rows, row];
      history.set(row.id, [entry(row.id, 'status', null, 'active', 'Alta', env.actorId(), 1, at)]);
      audit.push({ action: 'employee.created', id: row.id });
      return ok(view(row));
    },
    update: async (id, patch: EmployeePatch) => {
      const { version, ...rest } = patch as unknown as Record<string, unknown>;
      const parsed = parseFields(
        rest,
        CREATE_KEYS.filter((key) => key !== 'kind'),
        today(),
      );
      if (!validVersion(version) || parsed === null || Object.keys(rest).length === 0)
        return badRequest();
      const current = rows[index(id)];
      if (!current) return notFound();
      if (current.kind !== 'driver' && LICENSE_KEYS.some((key) => Object.hasOwn(rest, key)))
        return badRequest();
      if (current.archivedAt !== null || current.status === 'terminated')
        return conflict('immutable');
      if (current.version !== version) return conflict('stale_version');
      const { core, pii } = parsed;
      const movedTo =
        core.areaId !== undefined && core.areaId !== current.areaId ? core.areaId : null;
      if (movedTo !== null && !env.isActiveArea(movedTo)) return invalidArea();
      const next = bump(current, { ...core, pii: { ...current.pii, ...pii } } as Partial<Row>);
      const clash = collision(next);
      if (clash) return duplicate(clash);
      replace(next);
      if (movedTo !== null)
        record(
          id,
          entry(id, 'area', current.areaId, movedTo, null, env.actorId(), next.version, now()),
        );
      audit.push({ action: 'employee.updated', id });
      return ok(view(next));
    },
    changeStatus: async (id, change) => {
      const { version, status, reason } = change;
      if (
        !validVersion(version) ||
        !BFF_EMPLOYEE_STATUSES.includes(status) ||
        typeof reason !== 'string' ||
        !isReasonValid(reason)
      )
        return badRequest();
      const current = rows[index(id)];
      if (!current) return notFound();
      if (current.archivedAt !== null) return conflict('immutable');
      if (current.version !== version) return conflict('stale_version');
      if (!canTransition(current.status, status)) return conflict('invalid_transition');
      const next = replace(bump(current, { status, statusReason: reason.trim() }));
      record(
        id,
        entry(
          id,
          'status',
          current.status,
          status,
          reason.trim(),
          env.actorId(),
          next.version,
          now(),
        ),
      );
      audit.push({ action: 'employee.status_changed', id });
      return ok(view(next));
    },
    archive: async (id, version) => {
      const current = rows[index(id)];
      if (!validVersion(version)) return badRequest();
      if (!current) return notFound();
      if (current.archivedAt !== null) return conflict('immutable');
      if (current.version !== version) return conflict('stale_version');
      audit.push({ action: 'employee.archived', id });
      return ok(view(replace(bump(current, { archivedAt: now() }))));
    },
    history: async (id, query = {}) => {
      const slice = window(query);
      if (!slice) return badRequest();
      if (index(id) < 0) return notFound();
      const entries = [...(history.get(id) ?? [])].sort((a, b) => b.version - a.version);
      return ok(page(entries, slice.limit, slice.offset, 'version'));
    },
  };

  const external = (id: string, change: Partial<Row>) => {
    const current = rows[index(id)];
    if (current) replace(bump(current, change));
  };

  return {
    port,
    changeExternally: (id, change) => external(id, change),
    archiveExternally: (id) => external(id, { archivedAt: now() }),
    terminateExternally: (id) =>
      external(id, { status: 'terminated', statusReason: 'Baja externa' }),
    snapshot: () => rows.map(view),
    auditLog: () => audit.map((item) => ({ ...item })),
    countLiveInArea: (areaId) =>
      rows.filter(
        (row) => row.areaId === areaId && row.archivedAt === null && row.status !== 'terminated',
      ).length,
  };
}
