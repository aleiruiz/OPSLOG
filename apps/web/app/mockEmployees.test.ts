import { describe, expect, it } from 'vitest';
import { makeEmployeeDetail, noPii } from '../employees/fixtures';
import { createMockEmployeeStore, demoMockEmployees } from './mockEmployees';
import type { EmployeeDetail, EmployeeInput, EmployeePatch, Result } from './types';

const ACTIVE_AREAS = new Set(['area-norte', 'area-centro', 'area-sur']);
let canViewPii = true;
const store = (seed?: readonly EmployeeDetail[]) => {
  canViewPii = true;
  return createMockEmployeeStore(
    {
      isActiveArea: (id) => ACTIVE_AREAS.has(id),
      canViewPii: () => canViewPii,
      actorId: () => 'user-admin',
    },
    seed,
  );
};
const code = <T>(result: Result<T>) =>
  result.ok ? 'ok' : `${result.error.status} ${result.error.code}`;
const field = <T>(result: Result<T>) => (result.ok ? null : result.error.fieldErrors?.[0]?.field);
const value = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`unexpected ${result.error.code}`);
  return result.value;
};
const input = (overrides: Record<string, unknown> = {}): EmployeeInput =>
  ({
    kind: 'dispatcher',
    firstName: 'Nora',
    lastName: 'Quiroga',
    areaId: 'area-sur',
    ...overrides,
  }) as EmployeeInput;
const patch = (version: number, change: Record<string, unknown>): EmployeePatch =>
  ({ version, ...change }) as EmployeePatch;

describe('mock employees: reads', () => {
  it('lists by last name then first name with filters, cursor pages and a uniform 400', async () => {
    const { port } = store();
    const all = value(await port.list({ limit: 100 }));
    expect(all.total).toBe(28);
    expect(all.sort).toEqual({ field: 'lastName', direction: 'asc' });
    const keys = all.items.map((e) => `${e.lastName} ${e.firstName}`.toLowerCase());
    expect(keys).toEqual([...keys].sort());
    // The list never carries personal data, only which fields exist.
    expect(JSON.stringify(all)).not.toMatch(/ejemplo\.test|EJEM8001|LIC-/);
    expect(all.items[0]?.piiPresent).toEqual({
      nationalId: true,
      phone: true,
      email: true,
      licenseNumber: expect.any(Boolean),
    });
    const drivers = value(await port.list({ kind: 'driver', limit: 100 }));
    expect(drivers.items.every((e) => e.kind === 'driver' && e.fitness !== null)).toBe(true);
    expect(
      value(await port.list({ kind: 'dispatcher', limit: 100 })).items.every(
        (e) => e.fitness === null,
      ),
    ).toBe(true);
    expect(value(await port.list({ status: 'terminated', limit: 100 })).total).toBe(3);
    expect(value(await port.list({ areaId: 'area-sur', limit: 100 })).total).toBe(9);
    const first = value(await port.list({ limit: 25 }));
    expect(first.items).toHaveLength(25);
    expect(first.nextCursor).toBe('mock:25');
    const second = value(await port.list({ limit: 25, cursor: 'mock:25' }));
    expect(second.items).toHaveLength(3);
    expect(second.nextCursor).toBeNull();
    for (const query of [
      { limit: 7 as never },
      { cursor: 'zzz' },
      { kind: 'otro' as never },
      { status: 'despedido' as never },
      { areaId: 'no valido!' },
      { includeArchived: 'quizas' as never },
    ])
      expect(code(await port.list(query))).toBe('400 bad_request');
  });

  it('hides archived employees unless asked for them', async () => {
    const { port, archiveExternally } = store();
    archiveExternally('emp-002');
    expect(value(await port.list({ limit: 100 })).total).toBe(27);
    const all = value(await port.list({ limit: 100, includeArchived: 'true' }));
    expect(all.total).toBe(28);
    expect(all.items.find((e) => e.id === 'emp-002')?.archivedAt).not.toBeNull();
  });

  it('derives the fitness of a driver from status, archive and license', async () => {
    const { port } = store();
    const fitness = async (id: string) => value(await port.get(id)).fitness;
    expect(await fitness('emp-001')).toEqual({ fit: true, reasons: [] });
    // Every fifth driver has no license; every seventh an expired one (fixtures).
    expect((await fitness('emp-005'))?.reasons).toEqual(['not_active', 'license_missing']);
    expect((await fitness('emp-007'))?.reasons).toEqual(['not_active', 'license_expired']);
    expect(await fitness('emp-003')).toBeNull();
  });

  it('gets one employee with personal data only for a session that may see it', async () => {
    const mock = store();
    const withPii = value(await mock.port.get('emp-001'));
    expect(withPii.pii).toMatchObject({ nationalId: expect.stringContaining('EJEM') });
    expect(mock.auditLog()).toEqual([{ action: 'employee.pii_viewed', id: 'emp-001' }]);
    canViewPii = false;
    const masked = value(await mock.port.get('emp-001'));
    expect(masked.pii).toBeNull();
    expect(masked.piiPresent.nationalId).toBe(true);
    // A masked read discloses nothing, so nothing is audited.
    expect(mock.auditLog()).toHaveLength(1);
    expect(code(await mock.port.get('nadie'))).toBe('404 not_found');
  });

  it('does not audit a read that has nothing personal to disclose', async () => {
    const mock = store([makeEmployeeDetail({ id: 'emp-x' }, noPii)]);
    expect(value(await mock.port.get('emp-x')).pii).toEqual(noPii);
    expect(mock.auditLog()).toEqual([]);
  });
});

describe('mock employees: create', () => {
  it('creates an active employee with normalized values, a history entry and an audit event', async () => {
    const mock = store();
    const created = value(
      await mock.port.create(
        input({
          kind: 'driver',
          firstName: '  Nora   María ',
          employeeNumber: ' E-9000 ',
          position: ' Chofer ',
          hireDate: '2026-01-15',
          idType: 'INE',
          nationalId: ' ejem 9000 abc ',
          phone: '+52 (55) 5555-0199',
          email: ' Nora@Ejemplo.TEST ',
          licenseNumber: 'lic-9000',
          licenseType: 'c',
          licenseExpiresOn: '2029-01-01',
        }),
      ),
    );
    expect(created).toMatchObject({
      kind: 'driver',
      firstName: 'Nora María',
      employeeNumber: 'E-9000',
      position: 'Chofer',
      idType: 'ine',
      licenseType: 'C',
      status: 'active',
      statusReason: 'Alta',
      version: 1,
      archivedAt: null,
      piiPresent: { nationalId: true, phone: true, email: true, licenseNumber: true },
      fitness: { fit: true, reasons: [] },
    });
    expect(JSON.stringify(created)).not.toMatch(/ejemplo\.test|EJEM 9000|0199/i);
    canViewPii = true;
    expect(value(await mock.port.get(created.id)).pii).toEqual({
      nationalId: 'EJEM 9000 ABC',
      phone: '+525555550199',
      email: 'nora@ejemplo.test',
      licenseNumber: 'LIC-9000',
    });
    const history = value(await mock.port.history(created.id));
    expect(history.items).toHaveLength(1);
    expect(history.items[0]).toMatchObject({
      kind: 'status',
      from: null,
      to: 'active',
      reason: 'Alta',
      actorId: 'user-admin',
    });
    expect(mock.auditLog()[0]).toEqual({ action: 'employee.created', id: created.id });
    expect(mock.snapshot()).toHaveLength(29);
  });

  it.each([
    ['unknown key', { extra: 1 }],
    ['bad kind', { kind: 'mecanico' }],
    ['bad name', { firstName: '1nvalido' }],
    ['bad employee number', { employeeNumber: '*x' }],
    ['bad position', { position: 'a\nb' }],
    ['future hire date', { hireDate: '2027-01-01' }],
    ['impossible hire date', { hireDate: '2026-02-31' }],
    ['id type without number', { idType: 'ine' }],
    ['number without id type', { nationalId: 'EJEM 1234' }],
    ['half cleared pair', { idType: null, nationalId: 'EJEM 1234' }],
    ['bad id type', { idType: 'INE!', nationalId: 'EJEM 1234' }],
    ['bad national id', { idType: 'ine', nationalId: '12' }],
    ['bad phone', { phone: '5555' }],
    ['bad email', { email: 'sin-arroba' }],
    ['over-long email', { email: `${'a'.repeat(64)}@${'b'.repeat(190)}.com` }],
    ['license on a non-driver', { licenseType: 'C' }],
    ['non-text field', { position: 5 }],
  ])('rejects %s with a uniform 400', async (_name, change) => {
    expect(code(await store().port.create(input(change)))).toBe('400 bad_request');
  });

  it('requires kind, names and area', async () => {
    const { port } = store();
    for (const missing of ['kind', 'firstName', 'lastName', 'areaId']) {
      const body = { ...input() } as Record<string, unknown>;
      delete body[missing];
      expect(code(await port.create(body as unknown as EmployeeInput))).toBe('400 bad_request');
    }
  });

  it('refuses an unknown, foreign or inactive area with the same 422 and the area_id field', async () => {
    const { port } = store();
    for (const areaId of ['area-inexistente', 'area-mty-guadalupe']) {
      const result = await port.create(input({ areaId }));
      expect(code(result)).toBe('422 invalid_area');
      expect(field(result)).toBe('area_id');
    }
  });

  it('refuses a repeated employee number, identification or e-mail, naming only the field', async () => {
    const { port } = store();
    const number = await port.create(input({ employeeNumber: 'e-0001' }));
    expect(code(number)).toBe('409 duplicate');
    expect(field(number)).toBe('employee_number');
    const id = await port.create(input({ idType: 'curp', nationalId: 'ejem8001 01-hdfxxx01' }));
    expect(field(id)).toBe('national_id');
    // Same number under another identification type is a different identification.
    expect(
      code(await port.create(input({ idType: 'ine', nationalId: 'EJEM8001 01-HDFXXX01' }))),
    ).toBe('ok');
    const email = await port.create(input({ email: 'EMPLEADO1@ejemplo.test' }));
    expect(field(email)).toBe('email');
    expect(JSON.stringify(email)).not.toMatch(/EMPLEADO1|ejemplo/i);
  });
});

describe('mock employees: update', () => {
  it('applies a partial change, bumps the version, clears with null and audits it', async () => {
    const mock = store();
    const before = value(await mock.port.get('emp-001'));
    const next = value(
      await mock.port.update(
        'emp-001',
        patch(before.version, { position: null, firstName: 'Anita', phone: null }),
      ),
    );
    expect(next).toMatchObject({
      firstName: 'Anita',
      position: null,
      version: before.version + 1,
      piiPresent: { phone: false, email: true },
    });
    expect(mock.auditLog().at(-1)).toEqual({ action: 'employee.updated', id: 'emp-001' });
  });

  it('records a move between areas in the history, with ids and no reason', async () => {
    const mock = store();
    const before = value(await mock.port.get('emp-001'));
    const moved = value(
      await mock.port.update('emp-001', patch(before.version, { areaId: 'area-sur' })),
    );
    const newest = value(await mock.port.history('emp-001', { limit: 25 })).items[0];
    expect(newest).toMatchObject({
      kind: 'area',
      from: before.areaId,
      to: 'area-sur',
      reason: null,
      version: moved.version,
    });
    // An unchanged area is not checked and records nothing.
    const same = value(
      await mock.port.update('emp-001', patch(moved.version, { areaId: 'area-sur' })),
    );
    expect(value(await mock.port.history('emp-001', { limit: 25 })).items[0]?.version).toBe(
      moved.version,
    );
    expect(same.version).toBe(moved.version + 1);
  });

  it('keeps an area that was deactivated since, but refuses a move to one', async () => {
    const mock = store([makeEmployeeDetail({ id: 'emp-x', areaId: 'area-vieja' }, noPii)]);
    const kept = await mock.port.update('emp-x', patch(3, { position: 'Nuevo' }));
    expect(code(kept)).toBe('ok');
    expect(code(await mock.port.update('emp-x', patch(4, { areaId: 'area-vieja-2' })))).toBe(
      '422 invalid_area',
    );
  });

  it('sets and clears the identification as one unit', async () => {
    const mock = store();
    const current = value(await mock.port.get('emp-001'));
    expect(code(await mock.port.update('emp-001', patch(current.version, { idType: 'ine' })))).toBe(
      '400 bad_request',
    );
    const swapped = value(
      await mock.port.update(
        'emp-001',
        patch(current.version, { idType: 'ine', nationalId: 'ejem 0001' }),
      ),
    );
    expect(swapped.idType).toBe('ine');
    const cleared = value(
      await mock.port.update('emp-001', patch(swapped.version, { idType: null, nationalId: null })),
    );
    expect(cleared).toMatchObject({ idType: null, piiPresent: { nationalId: false } });
  });

  it('answers 400, 404, immutable, stale_version and duplicate like the backend', async () => {
    const mock = store();
    const { port } = mock;
    expect(code(await port.update('emp-001', patch(0, { position: 'x' })))).toBe('400 bad_request');
    expect(code(await port.update('emp-001', patch(1, {})))).toBe('400 bad_request');
    expect(code(await port.update('emp-001', patch(1, { kind: 'other' })))).toBe('400 bad_request');
    expect(code(await port.update('emp-001', patch(1, { areaId: 'no valido!' })))).toBe(
      '400 bad_request',
    );
    expect(code(await port.update('nadie', patch(1, { position: 'x' })))).toBe('404 not_found');
    // The license data of a non-driver is invalid.
    expect(code(await port.update('emp-003', patch(1, { licenseType: 'C' })))).toBe(
      '400 bad_request',
    );
    expect(code(await port.update('emp-001', patch(1, { position: 'x' })))).toBe(
      '409 stale_version',
    );
    const dup = await port.update('emp-001', patch(31, { employeeNumber: 'E-0002' }));
    expect(code(dup)).toBe('409 duplicate');
    expect(field(dup)).toBe('employee_number');
    mock.terminateExternally('emp-002');
    mock.archiveExternally('emp-003');
    expect(code(await port.update('emp-002', patch(1, { position: 'x' })))).toBe('409 immutable');
    expect(code(await port.update('emp-003', patch(1, { position: 'x' })))).toBe('409 immutable');
  });

  it('lets a change come from another actor, so a stale copy is detected', async () => {
    const mock = store();
    mock.changeExternally('emp-001', { position: 'Cambiado', firstName: 'Ana' });
    const result = await mock.port.update('emp-001', patch(31, { position: 'x' }));
    expect(code(result)).toBe('409 stale_version');
    mock.changeExternally('nadie', {});
  });
});

describe('mock employees: status and archive', () => {
  it('changes the status with a trimmed reason, records it and follows the matrix', async () => {
    const mock = store();
    const changed = value(
      await mock.port.changeStatus('emp-001', {
        version: 31,
        status: 'suspended',
        reason: '  Revisión interna  ',
      }),
    );
    expect(changed).toMatchObject({ status: 'suspended', statusReason: 'Revisión interna' });
    expect(changed.fitness?.reasons).toContain('not_active');
    const newest = value(await mock.port.history('emp-001')).items[0];
    expect(newest).toMatchObject({
      kind: 'status',
      from: 'active',
      to: 'suspended',
      reason: 'Revisión interna',
    });
    expect(mock.auditLog().at(-1)).toEqual({ action: 'employee.status_changed', id: 'emp-001' });
    // Same status is not a transition.
    expect(
      code(
        await mock.port.changeStatus('emp-001', { version: 32, status: 'suspended', reason: 'x' }),
      ),
    ).toBe('409 invalid_transition');
  });

  it('terminates for good: read-only, no way out, still archivable', async () => {
    const mock = store();
    const done = value(
      await mock.port.changeStatus('emp-001', {
        version: 31,
        status: 'terminated',
        reason: 'Renuncia',
      }),
    );
    expect(
      code(
        await mock.port.changeStatus('emp-001', {
          version: done.version,
          status: 'active',
          reason: 'x',
        }),
      ),
    ).toBe('409 invalid_transition');
    expect(code(await mock.port.update('emp-001', patch(done.version, { position: 'x' })))).toBe(
      '409 immutable',
    );
    expect(code(await mock.port.archive('emp-001', done.version))).toBe('ok');
  });

  it('answers 400, 404, immutable and stale_version', async () => {
    const mock = store();
    const { port } = mock;
    const body = (change: Record<string, unknown>) =>
      ({ version: 31, status: 'inactive', reason: 'ok', ...change }) as never;
    for (const bad of [
      { version: 0 },
      { status: 'despedido' },
      { reason: '' },
      { reason: '   ' },
      { reason: 'x'.repeat(201) },
      { reason: 'a\nb' },
      { reason: 5 },
    ])
      expect(code(await port.changeStatus('emp-001', body(bad)))).toBe('400 bad_request');
    expect(code(await port.changeStatus('nadie', body({})))).toBe('404 not_found');
    expect(code(await port.changeStatus('emp-001', body({ version: 2 })))).toBe(
      '409 stale_version',
    );
    mock.archiveExternally('emp-002');
    expect(code(await port.changeStatus('emp-002', body({ version: 2 })))).toBe('409 immutable');
  });

  it('archives once, with a version check, and keeps the row in the archived list', async () => {
    const mock = store();
    const { port } = mock;
    expect(code(await port.archive('emp-001', 0))).toBe('400 bad_request');
    expect(code(await port.archive('nadie', 1))).toBe('404 not_found');
    expect(code(await port.archive('emp-001', 2))).toBe('409 stale_version');
    const archived = value(await port.archive('emp-001', 31));
    expect(archived.archivedAt).not.toBeNull();
    expect(archived.fitness?.reasons).toContain('archived');
    expect(code(await port.archive('emp-001', archived.version))).toBe('409 immutable');
    expect(mock.auditLog().at(-1)).toEqual({ action: 'employee.archived', id: 'emp-001' });
    expect(code(await port.update('emp-001', patch(archived.version, { position: 'x' })))).toBe(
      '409 immutable',
    );
  });
});

describe('mock employees: history', () => {
  it('starts every employee with the hiring and pages a long history, newest first', async () => {
    const { port } = store();
    const short = value(await port.history('emp-002'));
    expect(short.items.map((e) => e.to)).toEqual(['active']);
    const first = value(await port.history('emp-001', { limit: 25 }));
    expect(first.total).toBe(31);
    expect(first.sort).toEqual({ field: 'version', direction: 'desc' });
    expect(first.items[0]?.version).toBeGreaterThan(first.items[1]?.version ?? 99);
    expect(first.nextCursor).toBe('mock:25');
    const second = value(await port.history('emp-001', { limit: 25, cursor: 'mock:25' }));
    expect(second.items).toHaveLength(6);
    expect(second.nextCursor).toBeNull();
    expect(second.items.at(-1)).toMatchObject({ from: null, to: 'active', reason: 'Alta' });
    expect(code(await port.history('emp-001', { limit: 7 as never }))).toBe('400 bad_request');
    expect(code(await port.history('nadie'))).toBe('404 not_found');
  });

  it('ends the history of a non-active employee on its current status and reason', async () => {
    const seed = makeEmployeeDetail(
      { id: 'emp-x', status: 'inactive', statusReason: 'Licencia sin goce', version: 3 },
      noPii,
    );
    const entries = value(await store([seed]).port.history('emp-x')).items;
    expect(entries.map((e) => `${e.from}>${e.to}`)).toEqual([
      'suspended>inactive',
      'active>suspended',
      'null>active',
    ]);
    expect(entries[0]?.reason).toBe('Licencia sin goce');
  });

  it('leaves no status entry for a version that did not change the status', async () => {
    // A version bump without a status change (a profile edit) leaves no status entry of its own.
    const seed = makeEmployeeDetail({ id: 'emp-x', status: 'active', version: 2 }, noPii);
    const entries = value(await store([seed]).port.history('emp-x')).items;
    expect(entries.map((e) => `${e.from}>${e.to}`)).toEqual(['null>active']);
  });
});

describe('mock employees: environment', () => {
  it('counts the employees that still hold their area (not archived, not terminated)', () => {
    const mock = store();
    const before = mock.countLiveInArea('area-norte');
    expect(before).toBeGreaterThan(0);
    mock.terminateExternally('emp-001');
    expect(mock.countLiveInArea('area-norte')).toBe(before - 1);
    mock.archiveExternally('emp-004');
    expect(mock.countLiveInArea('area-norte')).toBeLessThan(before);
  });

  it('starts from the demo staff and accepts a seed without personal data', () => {
    expect(demoMockEmployees()).toHaveLength(28);
    expect(demoMockEmployees().find((e) => e.id === 'emp-001')?.version).toBe(31);
    const mock = createMockEmployeeStore(
      { isActiveArea: () => true, canViewPii: () => true, actorId: () => 'x' },
      [{ ...makeEmployeeDetail({ id: 'emp-y' }), pii: null }],
    );
    expect(mock.snapshot()[0]?.piiPresent).toEqual({
      nationalId: false,
      phone: false,
      email: false,
      licenseNumber: false,
    });
  });
});
