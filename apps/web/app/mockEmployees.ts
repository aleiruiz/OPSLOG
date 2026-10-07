import { BFF_EMPLOYEE_KINDS, BFF_EMPLOYEE_STATUSES } from '@opslog/contracts';
import { FIXTURE_TODAY } from '../employees/fixtures';
import { OPAQUE_ID, canTransition, fitnessOf, isReasonValid } from '../employees/rules';
import {
  CREATE_KEYS,
  LICENSE_KEYS,
  badRequest,
  compare,
  conflict,
  demoMockEmployees,
  duplicate,
  idKey,
  invalidArea,
  notFound,
  ok,
  page,
  pageWindow,
  parseFields,
  seedHistory,
  sortKey,
  validVersion,
  type Row,
} from './mockEmployeesSupport';
import type {
  MockEmployeeEnvironment,
  MockEmployeeStore,
  EmployeeAuditAction,
} from './mockEmployeesTypes';
import type {
  Employee,
  EmployeeDetail,
  EmployeeHistoryEntry,
  EmployeeInput,
  EmployeeListQuery,
  EmployeePatch,
  EmployeesPort,
} from './types';

export { demoMockEmployees };
export type { EmployeeAuditAction, MockEmployeeEnvironment, MockEmployeeStore };

const NOW = '2026-10-06T12:00:00.000Z';

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
  const history = seedHistory(rows, entry);

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

  const port: EmployeesPort = {
    list: async (query: EmployeeListQuery = {}) => {
      const slice = pageWindow(query);
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
      const slice = pageWindow(query);
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
