import {
  BFF_ERRORS,
  BFF_ROUTES,
  CSRF_HEADER,
  bffPath,
  isBffErrorBody,
  type BffCallArgs,
  type BffResponseOf,
  type BffRouteId,
  type BffArea,
  type BffAreaDetail,
  type BffAreaHistoryEntry,
  type BffAreaHistoryQuery,
  type BffAreaInput,
  type BffAreaPatch,
  type BffAreasQuery,
  type BffSession,
  type BffDocument,
  type BffDocumentHistoryQuery,
  type BffDocumentInput,
  type BffDocumentPatch,
  type BffDocumentRenewal,
  type BffDocumentRevision,
  type BffDocumentsQuery,
  type BffImportEvent,
  type BffImportHistoryQuery,
  type BffImportInput,
  type BffImportJob,
  type BffImportRow,
  type BffImportRowsQuery,
  type BffImportSubmitted,
  type BffImportsQuery,
  type BffInsurancePoliciesQuery,
  type BffVehicleAssignment,
  type BffVehicleAssignmentCreated,
  type BffVehicleAssignmentEnd,
  type BffVehicleAssignmentEvent,
  type BffVehicleAssignmentHistoryQuery,
  type BffVehicleAssignmentInput,
  type BffVehicleAssignmentsQuery,
  type BffInsurancePolicy,
  type BffInsurancePolicyHistoryQuery,
  type BffInsurancePolicyInput,
  type BffInsurancePolicyPatch,
  type BffInsurancePolicyRenewal,
  type BffInsurancePolicyRevision,
  type BffEmployee,
  type BffEmployeeDetail,
  type BffEmployeeHistoryEntry,
  type BffEmployeeHistoryQuery,
  type BffEmployeeInput,
  type BffEmployeePatch,
  type BffEmployeesQuery,
  type BffEmployeeStatus,
  type BffVehicle,
  type BffVehicleInput,
  type BffVehiclePatch,
  type BffVehicleStatus,
  type BffVehicleStatusEntry,
  type BffVehiclesQuery,
} from './bff.js';
import type { ApiError, Page } from './index.js';

/** Outcome of a call: failures are values (uniform `ApiError`), never exceptions. */
export type BffResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ApiError };

/** The slice of `fetch` the client needs, so tests can run it against an in-process BFF. */
export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    credentials: 'same-origin';
    cache: 'no-store';
  },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface BffClientOptions {
  /** Origin prefix of the BFF; empty (default) means same-origin relative URLs. */
  readonly baseUrl?: string;
  readonly fetch?: FetchLike;
}

export interface BffClient {
  call<K extends BffRouteId>(id: K, ...args: BffCallArgs<K>): Promise<BffResult<BffResponseOf<K>>>;
}

const TOKEN_ROUTES: ReadonlySet<BffRouteId> = new Set([
  'auth.csrf',
  'auth.session',
  'auth.login',
  'auth.invitation.accept',
]);

const KNOWN_STATUSES: readonly number[] = [400, 401, 403, 404, 409, 422, 429, 500];

function failure(
  status: number,
  code: string,
  message: string,
  correlationId: string,
  field?: string,
): BffResult<never> {
  // The shared ApiError type has no 405/413/415: those are caller bugs and read as a bad request.
  const normalized = KNOWN_STATUSES.includes(status) ? status : status >= 500 ? 500 : 400;
  const error: ApiError = {
    code,
    status: normalized as ApiError['status'],
    message,
    correlationId,
    ...(field === undefined ? {} : { fieldErrors: [{ field, code, message }] }),
  };
  return { ok: false, error };
}

/**
 * Typed client for the BFF. Every call is derived from the contract module (`BFF_ROUTES`,
 * `BffRouteTypes`): method, path and protection are never written down here. It owns the CSRF
 * handshake: a pre-login token for sign-in and invitations, the session token (returned by the BFF
 * with the session, kept in memory only) for state changes. The session credential itself is an
 * httpOnly cookie that this code never sees.
 */
export function createBffClient(options: BffClientOptions = {}): BffClient {
  const baseUrl = options.baseUrl ?? '';
  const doFetch: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  let preToken: string | null = null;
  let sessionToken: string | null = null;

  async function exchange<K extends BffRouteId>(
    id: K,
    input: Record<string, unknown>,
    csrf: string | null,
  ): Promise<BffResult<BffResponseOf<K>>> {
    const definition = BFF_ROUTES[id];
    const path = bffPath(
      id,
      (input['params'] ?? {}) as Record<string, string>,
      (input['query'] ?? {}) as Record<string, string | number | undefined>,
    );
    const headers: Record<string, string> = { accept: 'application/json' };
    if (csrf !== null) headers[CSRF_HEADER] = csrf;
    const hasBody = input['body'] !== undefined;
    if (hasBody) headers['content-type'] = 'application/json';
    let response;
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        method: definition.method,
        headers,
        ...(hasBody ? { body: JSON.stringify(input['body']) } : {}),
        credentials: 'same-origin',
        cache: 'no-store',
      });
    } catch {
      return failure(500, 'network_error', 'No pudimos contactar al servidor.', 'client');
    }
    const correlationId = response.headers.get('x-correlation-id') ?? 'client';
    let raw = '';
    try {
      raw = await response.text();
    } catch {
      return failure(500, 'invalid_response', 'Respuesta ilegible.', correlationId);
    }
    let parsed: unknown;
    try {
      parsed = raw ? JSON.parse(raw) : undefined;
    } catch {
      return failure(500, 'invalid_response', 'Respuesta ilegible.', correlationId);
    }
    if (response.status !== definition.status) {
      if (isBffErrorBody(parsed))
        return failure(
          parsed.status,
          parsed.code,
          parsed.message,
          parsed.correlationId,
          parsed.field,
        );
      return failure(
        response.status,
        'invalid_response',
        'Respuesta inesperada del servidor.',
        correlationId,
      );
    }
    // Token-bearing responses must really carry the token: never trust a malformed 2xx body.
    if (
      TOKEN_ROUTES.has(id) &&
      (typeof parsed !== 'object' ||
        parsed === null ||
        typeof (parsed as { csrfToken?: unknown }).csrfToken !== 'string')
    )
      return failure(500, 'invalid_response', 'Respuesta inesperada del servidor.', correlationId);
    return { ok: true, value: parsed as BffResponseOf<K> };
  }

  // Concurrent callers share one in-flight `auth.csrf` exchange.
  let pendingPre: Promise<BffResult<string>> | null = null;
  function ensurePre(): Promise<BffResult<string>> {
    if (preToken !== null) return Promise.resolve({ ok: true, value: preToken });
    if (pendingPre) return pendingPre;
    const pending = (async (): Promise<BffResult<string>> => {
      try {
        const fetched = await exchange('auth.csrf', {}, null);
        if (!fetched.ok) return fetched;
        preToken = fetched.value.csrfToken;
        return { ok: true, value: preToken };
      } finally {
        pendingPre = null;
      }
    })();
    pendingPre = pending;
    return pending;
  }

  // Who the page believes is signed in ("user|company"). A silent token refresh must never switch it:
  // another tab sharing the cookie jar may have signed in as someone else, and a replayed write
  // would then land in that other person's company.
  let identity: string | null = null;
  const identityOf = (session: BffSession): string => `${session.user.id}|${session.company.id}`;

  async function ensureSession(): Promise<BffResult<string>> {
    if (sessionToken !== null) return { ok: true, value: sessionToken };
    const fetched = await exchange('auth.session', {}, null);
    if (!fetched.ok) return fetched;
    if (identity !== null && identityOf(fetched.value) !== identity)
      return failure(401, 'unauthorized', BFF_ERRORS.unauthorized.message, 'client');
    identity = identityOf(fetched.value);
    sessionToken = fetched.value.csrfToken;
    return { ok: true, value: sessionToken };
  }

  async function call<K extends BffRouteId>(
    id: K,
    ...args: BffCallArgs<K>
  ): Promise<BffResult<BffResponseOf<K>>> {
    const input = (args[0] ?? {}) as Record<string, unknown>;
    const kind = BFF_ROUTES[id].kind;
    const needsPre = kind === 'pre-session';
    const needsSession = kind === 'session-csrf';
    const tokenFor = (): Promise<BffResult<string>> | null =>
      needsPre ? ensurePre() : needsSession ? ensureSession() : null;

    let csrf: string | null = null;
    const first = tokenFor();
    if (first) {
      const token = await first;
      if (!token.ok) return token;
      csrf = token.value;
    }
    let result = await exchange(id, input, csrf);
    if (!result.ok && result.error.code === 'csrf_failed' && first) {
      // The pre-login cookie or the session moved on: refresh the token once and retry.
      if (needsPre) preToken = null;
      else sessionToken = null;
      const again = await (tokenFor() as Promise<BffResult<string>>);
      if (!again.ok) return again;
      result = await exchange(id, input, again.value);
    }
    if (result.ok) {
      if (id === 'auth.csrf') preToken = (result.value as BffResponseOf<'auth.csrf'>).csrfToken;
      if (id === 'auth.session' || id === 'auth.login' || id === 'auth.invitation.accept') {
        sessionToken = (result.value as BffSession).csrfToken;
        identity = identityOf(result.value as BffSession);
        preToken = null;
      }
      if (id === 'auth.logout') {
        sessionToken = null;
        identity = null;
        preToken = null;
      }
    } else if (result.error.status === 401 && (kind === 'session' || kind === 'session-csrf')) {
      sessionToken = null;
    }
    return result;
  }

  return { call };
}

/**
 * Typed vehicle calls over any `BffClient`. Each method is one route of the contract; the
 * `version` of the last read travels with every change, and a lost race comes back as the
 * `stale_version` error value (never an exception).
 */
export interface VehiclesClient {
  list(query?: BffVehiclesQuery): Promise<BffResult<Page<BffVehicle>>>;
  get(id: string): Promise<BffResult<BffVehicle>>;
  create(input: BffVehicleInput): Promise<BffResult<BffVehicle>>;
  update(id: string, patch: BffVehiclePatch): Promise<BffResult<BffVehicle>>;
  changeStatus(
    id: string,
    change: { version: number; status: BffVehicleStatus; reason: string },
  ): Promise<BffResult<BffVehicle>>;
  recordOdometer(
    id: string,
    reading: { version: number; odometerKm: number },
  ): Promise<BffResult<BffVehicle>>;
  archive(id: string, version: number): Promise<BffResult<BffVehicle>>;
  history(id: string): Promise<BffResult<{ items: readonly BffVehicleStatusEntry[] }>>;
}

export function createVehiclesClient(client: BffClient): VehiclesClient {
  return {
    list: (query) =>
      query ? client.call('vehicles.list', { query }) : client.call('vehicles.list'),
    get: (id) => client.call('vehicles.get', { params: { id } }),
    create: (input) => client.call('vehicles.create', { body: input }),
    update: (id, patch) => client.call('vehicles.update', { params: { id }, body: patch }),
    changeStatus: (id, change) => client.call('vehicles.status', { params: { id }, body: change }),
    recordOdometer: (id, reading) =>
      client.call('vehicles.odometer', { params: { id }, body: reading }),
    archive: (id, version) =>
      client.call('vehicles.archive', { params: { id }, body: { version } }),
    history: (id) => client.call('vehicles.history', { params: { id } }),
  };
}

/**
 * Typed area calls over any `BffClient`. Each method is one route of the contract; the `version`
 * of the last read travels with every change, and a lost race comes back as the `stale_version`
 * error value (never an exception). Moving an area is an `update` with a new `parentId`.
 */
export interface AreasClient {
  list(query?: BffAreasQuery): Promise<BffResult<Page<BffArea>>>;
  get(id: string): Promise<BffResult<BffAreaDetail>>;
  create(input: BffAreaInput): Promise<BffResult<BffArea>>;
  update(id: string, patch: BffAreaPatch): Promise<BffResult<BffArea>>;
  deactivate(id: string, version: number): Promise<BffResult<BffArea>>;
  activate(id: string, version: number): Promise<BffResult<BffArea>>;
  history(id: string, query?: BffAreaHistoryQuery): Promise<BffResult<Page<BffAreaHistoryEntry>>>;
}

export function createAreasClient(client: BffClient): AreasClient {
  return {
    list: (query) => (query ? client.call('areas.list', { query }) : client.call('areas.list')),
    get: (id) => client.call('areas.get', { params: { id } }),
    create: (input) => client.call('areas.create', { body: input }),
    update: (id, patch) => client.call('areas.update', { params: { id }, body: patch }),
    deactivate: (id, version) =>
      client.call('areas.deactivate', { params: { id }, body: { version } }),
    activate: (id, version) => client.call('areas.activate', { params: { id }, body: { version } }),
    history: (id, query) =>
      query
        ? client.call('areas.history', { params: { id }, query })
        : client.call('areas.history', { params: { id } }),
  };
}

/**
 * Typed employee calls over any `BffClient`. Each method is one route of the contract; the
 * `version` of the last read travels with every change, and a lost race comes back as the
 * `stale_version` error value (never an exception). Moving an employee to another area is an
 * `update` with a new `areaId`. Only `get` can carry personal data (`pii`), and only for a session
 * with the PII permission.
 */
export interface EmployeesClient {
  list(query?: BffEmployeesQuery): Promise<BffResult<Page<BffEmployee>>>;
  get(id: string): Promise<BffResult<BffEmployeeDetail>>;
  create(input: BffEmployeeInput): Promise<BffResult<BffEmployee>>;
  update(id: string, patch: BffEmployeePatch): Promise<BffResult<BffEmployee>>;
  changeStatus(
    id: string,
    change: { version: number; status: BffEmployeeStatus; reason: string },
  ): Promise<BffResult<BffEmployee>>;
  archive(id: string, version: number): Promise<BffResult<BffEmployee>>;
  history(
    id: string,
    query?: BffEmployeeHistoryQuery,
  ): Promise<BffResult<Page<BffEmployeeHistoryEntry>>>;
}

export function createEmployeesClient(client: BffClient): EmployeesClient {
  return {
    list: (query) =>
      query ? client.call('employees.list', { query }) : client.call('employees.list'),
    get: (id) => client.call('employees.get', { params: { id } }),
    create: (input) => client.call('employees.create', { body: input }),
    update: (id, patch) => client.call('employees.update', { params: { id }, body: patch }),
    changeStatus: (id, change) => client.call('employees.status', { params: { id }, body: change }),
    archive: (id, version) =>
      client.call('employees.archive', { params: { id }, body: { version } }),
    history: (id, query) =>
      query
        ? client.call('employees.history', { params: { id }, query })
        : client.call('employees.history', { params: { id } }),
  };
}

/**
 * Typed document calls over any `BffClient`. Each method is one route of the contract; the
 * `version` of the last read travels with every change, and a lost race comes back as the
 * `stale_version` error value (never an exception). `renew` appends a revision (the previous ones
 * stay in `history`); `update` only edits the title and the notes. Metadata only: files are not
 * part of this contract yet.
 */
export interface DocumentsClient {
  list(query?: BffDocumentsQuery): Promise<BffResult<Page<BffDocument>>>;
  get(id: string): Promise<BffResult<BffDocument>>;
  create(input: BffDocumentInput): Promise<BffResult<BffDocument>>;
  update(id: string, patch: BffDocumentPatch): Promise<BffResult<BffDocument>>;
  renew(id: string, renewal: BffDocumentRenewal): Promise<BffResult<BffDocument>>;
  archive(id: string, version: number): Promise<BffResult<BffDocument>>;
  history(
    id: string,
    query?: BffDocumentHistoryQuery,
  ): Promise<BffResult<Page<BffDocumentRevision>>>;
}

export function createDocumentsClient(client: BffClient): DocumentsClient {
  return {
    list: (query) =>
      query ? client.call('documents.list', { query }) : client.call('documents.list'),
    get: (id) => client.call('documents.get', { params: { id } }),
    create: (input) => client.call('documents.create', { body: input }),
    update: (id, patch) => client.call('documents.update', { params: { id }, body: patch }),
    renew: (id, renewal) => client.call('documents.renew', { params: { id }, body: renewal }),
    archive: (id, version) =>
      client.call('documents.archive', { params: { id }, body: { version } }),
    history: (id, query) =>
      query
        ? client.call('documents.history', { params: { id }, query })
        : client.call('documents.history', { params: { id } }),
  };
}

/**
 * Typed insurance policy calls over any `BffClient`. Each method is one route of the contract; the
 * `version` of the last read travels with every change, and a lost race comes back as the
 * `stale_version` error value (never an exception). `renew` appends a revision (the previous ones
 * stay in `history`); `update` only edits the insurer name and the notes. The deductible is
 * financial data: it is `null` in every response unless the session holds `view_costs`, and
 * writing one needs that permission too (a `forbidden` error value otherwise).
 */
export interface InsuranceClient {
  list(query?: BffInsurancePoliciesQuery): Promise<BffResult<Page<BffInsurancePolicy>>>;
  get(id: string): Promise<BffResult<BffInsurancePolicy>>;
  create(input: BffInsurancePolicyInput): Promise<BffResult<BffInsurancePolicy>>;
  update(id: string, patch: BffInsurancePolicyPatch): Promise<BffResult<BffInsurancePolicy>>;
  renew(id: string, renewal: BffInsurancePolicyRenewal): Promise<BffResult<BffInsurancePolicy>>;
  archive(id: string, version: number): Promise<BffResult<BffInsurancePolicy>>;
  history(
    id: string,
    query?: BffInsurancePolicyHistoryQuery,
  ): Promise<BffResult<Page<BffInsurancePolicyRevision>>>;
}

export function createInsuranceClient(client: BffClient): InsuranceClient {
  return {
    list: (query) =>
      query ? client.call('insurance.list', { query }) : client.call('insurance.list'),
    get: (id) => client.call('insurance.get', { params: { id } }),
    create: (input) => client.call('insurance.create', { body: input }),
    update: (id, patch) => client.call('insurance.update', { params: { id }, body: patch }),
    renew: (id, renewal) => client.call('insurance.renew', { params: { id }, body: renewal }),
    archive: (id, version) =>
      client.call('insurance.archive', { params: { id }, body: { version } }),
    history: (id, query) =>
      query
        ? client.call('insurance.history', { params: { id }, query })
        : client.call('insurance.history', { params: { id } }),
  };
}

/**
 * Typed driver-vehicle assignment calls over any `BffClient`. Each method is one route of the
 * contract. `assign` rejects a second principal with the `principal_taken` error value (its field
 * names `vehicle_id` or `employee_id`) unless `replace: true`; `end` closes an assignment with a
 * reason and the `version` of the last read; assignments are never edited or deleted, and a lost
 * race comes back as the `stale_version` error value (never an exception).
 */
export interface AssignmentsClient {
  list(query?: BffVehicleAssignmentsQuery): Promise<BffResult<Page<BffVehicleAssignment>>>;
  get(id: string): Promise<BffResult<BffVehicleAssignment>>;
  assign(input: BffVehicleAssignmentInput): Promise<BffResult<BffVehicleAssignmentCreated>>;
  end(id: string, end: BffVehicleAssignmentEnd): Promise<BffResult<BffVehicleAssignment>>;
  history(
    id: string,
    query?: BffVehicleAssignmentHistoryQuery,
  ): Promise<BffResult<Page<BffVehicleAssignmentEvent>>>;
}

export function createAssignmentsClient(client: BffClient): AssignmentsClient {
  return {
    list: (query) =>
      query ? client.call('assignments.list', { query }) : client.call('assignments.list'),
    get: (id) => client.call('assignments.get', { params: { id } }),
    assign: (input) => client.call('assignments.create', { body: input }),
    end: (id, end) => client.call('assignments.end', { params: { id }, body: end }),
    history: (id, query) =>
      query
        ? client.call('assignments.history', { params: { id }, query })
        : client.call('assignments.history', { params: { id } }),
  };
}

/**
 * Typed bulk-import calls over any `BffClient`. Each method is one route of the contract. `submit`
 * runs a dry run or a commit (`commit_all` / `commit_valid`, which need an `idempotencyKey`): a
 * retry with the same key and rows returns the stored job (`replayed: true`) instead of importing
 * again, and the same key with other rows comes back as the `conflict` error value. The per-row
 * error report is `rows(id, { outcome: 'invalid' })`: row numbers, a code and column names, never a
 * submitted value.
 */
export interface ImportsClient {
  list(query?: BffImportsQuery): Promise<BffResult<Page<BffImportJob>>>;
  get(id: string): Promise<BffResult<BffImportJob>>;
  submit(input: BffImportInput): Promise<BffResult<BffImportSubmitted>>;
  rows(id: string, query?: BffImportRowsQuery): Promise<BffResult<Page<BffImportRow>>>;
  history(id: string, query?: BffImportHistoryQuery): Promise<BffResult<Page<BffImportEvent>>>;
}

export function createImportsClient(client: BffClient): ImportsClient {
  return {
    list: (query) => (query ? client.call('imports.list', { query }) : client.call('imports.list')),
    get: (id) => client.call('imports.get', { params: { id } }),
    submit: (input) => client.call('imports.create', { body: input }),
    rows: (id, query) =>
      query
        ? client.call('imports.rows', { params: { id }, query })
        : client.call('imports.rows', { params: { id } }),
    history: (id, query) =>
      query
        ? client.call('imports.history', { params: { id }, query })
        : client.call('imports.history', { params: { id } }),
  };
}
