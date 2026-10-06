import { afterEach, describe, expect, it } from 'vitest';
import {
  BFF_ERRORS,
  BFF_ROUTES,
  bffRouteIds,
  createAreasClient,
  createBffClient,
  createDocumentsClient,
  createAssignmentsClient,
  createInsuranceClient,
  createEmployeesClient,
  createVehiclesClient,
  type BffClient,
  type BffRouteId,
  type FetchLike,
} from '../../../packages/contracts/src/index.js';
import { ROUTES } from '../../../apps/api/bff/src/routes.js';
import {
  HOST,
  ORIGIN,
  createBffWorld,
  type BffWorld,
} from '../../../apps/api/bff/src/test-support.js';

let world: BffWorld;
afterEach(() => world?.dispose());

/**
 * `fetch` as a same-origin browser would run it against the in-process BFF: one cookie jar,
 * `Origin` and `Sec-Fetch-Site` on state changes, `Set-Cookie` honoured. The cookie is invisible
 * to the client code, exactly as an httpOnly cookie is invisible to the page.
 */
function browserFetch(handler: BffWorld['handler']): FetchLike {
  const jar = new Map<string, string>();
  return async (url, init) => {
    const headers: Record<string, string> = { ...init.headers, host: HOST };
    if (init.method !== 'GET') {
      headers['origin'] = ORIGIN;
      headers['sec-fetch-site'] = 'same-origin';
    }
    const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
    if (cookie) headers['cookie'] = cookie;
    const body = init.body;
    const response = await handler({
      method: init.method,
      url,
      headers,
      body:
        body === undefined
          ? null
          : (async function* () {
              yield Buffer.from(body);
            })(),
    });
    for (const line of ([] as string[]).concat(response.headers['set-cookie'] ?? [])) {
      const [pair = '', ...attributes] = line.split(';').map((part) => part.trim());
      const separator = pair.indexOf('=');
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      if (attributes.includes('Max-Age=0') || value === '') jar.delete(name);
      else jar.set(name, value);
    }
    const correlation = response.headers['x-correlation-id'];
    return {
      status: response.status,
      headers: {
        get: (name: string) => (name === 'x-correlation-id' ? String(correlation ?? '') : null),
      },
      text: async () => response.body,
    };
  };
}

/** A client that records which routes were exercised. */
function trackedClient(handler: BffWorld['handler']) {
  const inner = createBffClient({ fetch: browserFetch(handler) });
  const used = new Set<BffRouteId>();
  const client: BffClient = {
    call: (id, ...args) => {
      used.add(id);
      return inner.call(id, ...args);
    },
  };
  return { client, used };
}

describe('contract drift: BFF routing table against the contract module', () => {
  // Method, path and protection are taken from BFF_ROUTES by construction, so only what the BFF
  // declares on its own can drift: which routes exist and the parameter patterns of its handlers.
  it('implements exactly the routes the contract declares, with a pattern per path parameter', () => {
    expect(ROUTES.map((route) => route.id).sort()).toEqual([...bffRouteIds].sort());
    for (const route of ROUTES) {
      const names = BFF_ROUTES[route.id].path
        .filter((s) => s.startsWith(':'))
        .map((s) => s.slice(1));
      expect(Object.keys(route.params ?? {}).sort()).toEqual(names.sort());
    }
  });

  it('reports the contract status for an unauthenticated call', async () => {
    world = createBffWorld();
    const { client } = trackedClient(world.handler);
    // An unauthenticated read is a uniform 401 with the status the contract declares.
    expect(await client.call('users.list')).toMatchObject({
      ok: false,
      error: { code: 'unauthorized', status: BFF_ERRORS.unauthorized.status },
    });
  });
});

describe('typed client against the real BFF', () => {
  it('walks every contract route end to end with the CSRF handshake and cookie session', async () => {
    world = createBffWorld();
    await world.tenant('Empresa Alfa', 'subject-admin');
    const editor = await world.member('subject-admin', 'editor', 'subject-editor');
    const { client, used } = trackedClient(world.handler);

    // Pre-login: token, then OIDC sign-in. The page only ever sees the CSRF token, not the cookie.
    const login = await client.call('auth.login', { body: world.credentials('subject-admin') });
    expect(login).toMatchObject({
      ok: true,
      value: { company: { name: 'Empresa Alfa' }, roleId: 'admin', roleLabel: 'Administrador' },
    });
    if (!login.ok) throw new Error('login failed');
    expect(Object.keys(login.value.user)).toEqual(['id']);
    expect(login.value.permissions).toContain('manage_users');

    const session = await client.call('auth.session');
    expect(session).toMatchObject({ ok: true, value: { user: login.value.user } });

    const settings = await client.call('company.settings.get');
    expect(settings).toMatchObject({ ok: true, value: { name: 'Empresa Alfa', status: 'active' } });
    const updated = await client.call('company.settings.update', {
      body: { name: 'Empresa Alfa SA', mfa: 'required', sessionIdleHours: 4, reason: 'Política' },
    });
    expect(updated).toMatchObject({
      ok: true,
      value: { name: 'Empresa Alfa SA', mfa: 'required', sessionIdleHours: 4 },
    });
    expect(
      await client.call('company.settings.update', {
        body: { name: 'Sin motivo', mfa: 'optional', sessionIdleHours: 4 },
      }),
    ).toMatchObject({ ok: false, error: { code: 'bad_request', status: 400 } });

    // Roles
    const roles = await client.call('roles.list');
    expect(roles.ok && roles.value.items.map((role) => role.id)).toContain('viewer');
    const copy = await client.call('roles.copy', {
      params: { id: 'viewer' },
      body: { name: 'Consulta ampliada' },
    });
    expect(copy).toMatchObject({ ok: true, value: { kind: 'custom', name: 'Consulta ampliada' } });
    expect(
      await client.call('roles.copy', {
        params: { id: 'viewer' },
        body: { name: 'Consulta ampliada' },
      }),
    ).toMatchObject({ ok: false, error: { status: 409 } });

    // Users: invitation, signed cursors, deactivation.
    const issued: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const invited = await client.call('users.invite', { body: { roleId: 'viewer' } });
      if (!invited.ok) throw new Error('invite failed');
      expect(invited.value.user.status).toBe('invited');
      issued.push(invited.value.invitationToken);
    }
    const first = await client.call('users.list', { query: { limit: 25, sort: 'id' } });
    if (!first.ok) throw new Error('list failed');
    expect(first.value.total).toBe(5);
    expect(Object.keys(first.value.items[0] ?? {}).sort()).toEqual([
      'id',
      'roleId',
      'roleLabel',
      'status',
    ]);
    const forged = await client.call('users.list', { query: { cursor: 'forjado.forjado' } });
    expect(forged).toMatchObject({ ok: false, error: { code: 'bad_request' } });
    const pending = await client.call('users.list', { query: { search: 'invited', limit: 25 } });
    expect(pending.ok && pending.value.total).toBe(3);
    // A pending invitation is not a member: only active members can be deactivated.
    const target = editor.identityId;
    expect(
      await client.call('users.deactivate', { params: { id: target }, body: { reason: 'Baja' } }),
    ).toEqual({ ok: true, value: { id: target, status: 'inactive' } });

    // Vehicles through the typed client.
    const vehicles = createVehiclesClient(client);
    const fleet = await createAreasClient(client).create({ name: 'Flota' });
    if (!fleet.ok) throw new Error('fleet area failed');
    const input = {
      economicNumber: 'U-001',
      plate: 'abc 123',
      vin: null,
      make: 'Toyota',
      model: 'Hilux',
      year: 2022,
      areaId: fleet.value.id,
      odometerKm: 100,
    };
    const car = await vehicles.create(input);
    if (!car.ok) throw new Error('vehicle create failed');
    expect(car.value).toMatchObject({ plate: 'ABC 123', status: 'active', version: 1 });
    // An unknown area is a field-level 422 (the same for foreign and inactive areas).
    expect(
      await vehicles.create({ ...input, economicNumber: 'U-9', plate: 'OTRA9', areaId: 'nope' }),
    ).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_area',
        status: 422,
        fieldErrors: [expect.objectContaining({ field: 'area_id' })],
      },
    });
    expect(await vehicles.create({ ...input, plate: 'OTRA1' })).toMatchObject({
      ok: false,
      error: {
        code: 'duplicate',
        status: 409,
        fieldErrors: [expect.objectContaining({ field: 'economic_number' })],
      },
    });
    const edited = await vehicles.update(car.value.id, { version: 1, make: 'Ford' });
    expect(edited).toMatchObject({ ok: true, value: { make: 'Ford', version: 2 } });
    expect(await vehicles.update(car.value.id, { version: 1, make: 'Stale' })).toMatchObject({
      ok: false,
      error: { code: 'stale_version', status: 409 },
    });
    expect(
      await vehicles.changeStatus(car.value.id, {
        version: 2,
        status: 'restricted',
        reason: 'Revisión',
      }),
    ).toMatchObject({ ok: true, value: { status: 'restricted', version: 3 } });
    expect(
      await vehicles.recordOdometer(car.value.id, { version: 3, odometerKm: 50 }),
    ).toMatchObject({
      ok: false,
      error: { code: 'odometer_decrease', status: 422 },
    });
    expect(
      await vehicles.recordOdometer(car.value.id, { version: 3, odometerKm: 250 }),
    ).toMatchObject({
      ok: true,
      value: { odometerKm: 250, version: 4 },
    });
    expect(await vehicles.get(car.value.id)).toMatchObject({ ok: true, value: { version: 4 } });
    const listed = await vehicles.list({ status: 'restricted' });
    expect(listed.ok && listed.value.total).toBe(1);
    const trail = await vehicles.history(car.value.id);
    expect(trail.ok && trail.value.items.map((entry) => entry.to)).toEqual([
      'active',
      'restricted',
    ]);
    expect(await vehicles.archive(car.value.id, 4)).toMatchObject({
      ok: true,
      value: { archivedAt: expect.any(String) },
    });
    expect(await vehicles.get('desconocido')).toMatchObject({ ok: false, error: { status: 404 } });

    // Areas through the typed client.
    const areas = createAreasClient(client);
    const root = await areas.create({
      name: 'Pais',
      code: 'mx',
      responsibleIds: [login.value.user.id],
    });
    if (!root.ok) throw new Error('area create failed');
    expect(root.value).toMatchObject({ code: 'MX', depth: 1, version: 1, parentId: null });
    const leaf = await areas.create({ name: 'Ciudad', parentId: root.value.id });
    if (!leaf.ok) throw new Error('area child failed');
    expect(await areas.create({ name: 'pais' })).toMatchObject({
      ok: false,
      error: { status: 409, code: 'duplicate', fieldErrors: [{ field: 'name' }] },
    });
    expect(await areas.deactivate(root.value.id, 1)).toMatchObject({
      ok: false,
      error: { status: 409, code: 'area_in_use', fieldErrors: [{ field: 'sub_areas' }] },
    });
    expect(
      await areas.update(root.value.id, { version: 1, parentId: leaf.value.id }),
    ).toMatchObject({
      ok: false,
      error: { status: 422, code: 'invalid_hierarchy' },
    });
    expect(await areas.update(leaf.value.id, { version: 1, name: 'Ciudad Norte' })).toMatchObject({
      ok: true,
      value: { name: 'Ciudad Norte', version: 2 },
    });
    expect(await areas.get(root.value.id)).toMatchObject({
      ok: true,
      value: { resourceCounts: { vehicles: 0, people: 0 } },
    });
    expect(await areas.deactivate(leaf.value.id, 2)).toMatchObject({
      ok: true,
      value: { active: false },
    });
    // The fleet area, the country root (the deactivated city is hidden).
    expect(await areas.list()).toMatchObject({ ok: true, value: { total: 2 } });
    expect(await areas.list({ includeInactive: 'true', parentId: root.value.id })).toMatchObject({
      ok: true,
      value: { total: 1, items: [{ active: false }] },
    });
    expect(await areas.activate(leaf.value.id, 3)).toMatchObject({
      ok: true,
      value: { active: true, version: 4 },
    });
    const areaTrail = await areas.history(leaf.value.id);
    expect(areaTrail).toMatchObject({ ok: true, value: { total: 4 } });
    expect(areaTrail.ok && areaTrail.value.items[0]).toMatchObject({ action: 'activated' });
    expect(await areas.history(leaf.value.id, { limit: 25 })).toMatchObject({
      ok: true,
      value: { nextCursor: null },
    });
    expect(await areas.get('desconocido')).toMatchObject({ ok: false, error: { status: 404 } });

    // Employees through the typed client.
    const employees = createEmployeesClient(client);
    const worker = await employees.create({
      kind: 'driver',
      firstName: 'Ana',
      lastName: 'Perez',
      areaId: fleet.value.id,
      employeeNumber: 'E-001',
      idType: 'ine',
      nationalId: 'SYNTH-ID-0001',
      licenseNumber: 'LIC-0001',
      licenseType: 'c',
      licenseExpiresOn: '2099-01-31',
    });
    if (!worker.ok) throw new Error('employee create failed');
    expect(worker.value).toMatchObject({
      status: 'active',
      version: 1,
      piiPresent: { nationalId: true },
    });
    expect(JSON.stringify(worker.value)).not.toContain('SYNTH-ID-0001');
    expect(
      await employees.create({ kind: 'other', firstName: 'X', lastName: 'Y', areaId: 'nope' }),
    ).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_area',
        status: 422,
        fieldErrors: [expect.objectContaining({ field: 'area_id' })],
      },
    });
    expect(await employees.get(worker.value.id)).toMatchObject({
      ok: true,
      value: { pii: { nationalId: 'SYNTH-ID-0001' } },
    });
    expect(await employees.update(worker.value.id, { version: 1, position: 'Jefe' })).toMatchObject(
      {
        ok: true,
        value: { version: 2 },
      },
    );
    expect(
      await employees.update(worker.value.id, { version: 1, position: 'Viejo' }),
    ).toMatchObject({
      ok: false,
      error: { code: 'stale_version', status: 409 },
    });
    expect(
      await employees.changeStatus(worker.value.id, {
        version: 2,
        status: 'inactive',
        reason: 'Licencia',
      }),
    ).toMatchObject({ ok: true, value: { status: 'inactive', version: 3 } });
    expect(await employees.list({ status: 'inactive' })).toMatchObject({
      ok: true,
      value: { total: 1 },
    });
    expect(await employees.list()).toMatchObject({ ok: true, value: { total: 1 } });
    const staffTrail = await employees.history(worker.value.id, { limit: 25 });
    expect(staffTrail).toMatchObject({ ok: true, value: { total: 2 } });
    expect(await employees.archive(worker.value.id, 3)).toMatchObject({
      ok: true,
      value: { version: 4 },
    });
    expect(await employees.get('desconocido')).toMatchObject({ ok: false, error: { status: 404 } });

    // Documents through the typed client.
    const documents = createDocumentsClient(client);
    const truck = await vehicles.create({ ...input, economicNumber: 'U-DOC', plate: 'DOC111' });
    if (!truck.ok) throw new Error('document owner failed');
    const tarjeta = await documents.create({
      ownerType: 'vehicle',
      ownerId: truck.value.id,
      typeCode: 'registration_card',
      title: 'Tarjeta de circulación',
      expiresOn: '2026-10-20',
    });
    if (!tarjeta.ok) throw new Error('document create failed');
    expect(tarjeta.value).toMatchObject({
      status: 'expiring',
      daysToExpiry: 14,
      revision: 1,
      version: 1,
    });
    expect(
      await documents.create({
        ownerType: 'vehicle',
        ownerId: 'nope',
        typeCode: 'registration_card',
        title: 'x',
        expiresOn: '2026-10-20',
      }),
    ).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_owner',
        status: 422,
        fieldErrors: [expect.objectContaining({ field: 'owner_id' })],
      },
    });
    expect(await documents.update(tarjeta.value.id, { version: 1, title: 'Otra' })).toMatchObject({
      ok: true,
      value: { version: 2 },
    });
    expect(await documents.update(tarjeta.value.id, { version: 1, title: 'Vieja' })).toMatchObject({
      ok: false,
      error: { code: 'stale_version', status: 409 },
    });
    expect(
      await documents.renew(tarjeta.value.id, { version: 2, expiresOn: '2028-10-20' }),
    ).toMatchObject({ ok: true, value: { revision: 2, version: 3, status: 'valid' } });
    expect(await documents.list({ status: 'expiring' })).toMatchObject({
      ok: true,
      value: { total: 0 },
    });
    expect(await documents.history(tarjeta.value.id, { limit: 25 })).toMatchObject({
      ok: true,
      value: { total: 2 },
    });
    expect(await documents.archive(tarjeta.value.id, 3)).toMatchObject({
      ok: true,
      value: { version: 4 },
    });
    expect(await documents.get('desconocido')).toMatchObject({ ok: false, error: { status: 404 } });

    // Insurance policies through the typed client.
    const insurance = createInsuranceClient(client);
    const policy = await insurance.create({
      vehicleId: truck.value.id,
      insurer: 'Aseguradora Ficticia',
      policyNumber: 'POL-1',
      coverageType: 'comprehensive',
      startsOn: '2026-01-01',
      endsOn: '2026-10-20',
      deductible: { kind: 'percent', basisPoints: 1000 },
    });
    if (!policy.ok) throw new Error('policy create failed');
    expect(policy.value).toMatchObject({
      status: 'expiring',
      daysToExpiry: 14,
      covering: true,
      hasDeductible: true,
      deductible: { kind: 'percent', basisPoints: 1000 },
      revision: 1,
      version: 1,
    });
    expect(
      await insurance.create({
        vehicleId: 'nope',
        insurer: 'Aseguradora Ficticia',
        policyNumber: 'POL-2',
        coverageType: 'other',
        startsOn: '2026-01-01',
        endsOn: '2026-10-20',
      }),
    ).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_vehicle',
        status: 422,
        fieldErrors: [expect.objectContaining({ field: 'vehicle_id' })],
      },
    });
    expect(await insurance.update(policy.value.id, { version: 1, insurer: 'Otra' })).toMatchObject({
      ok: true,
      value: { version: 2 },
    });
    expect(await insurance.update(policy.value.id, { version: 1, insurer: 'Vieja' })).toMatchObject(
      { ok: false, error: { code: 'stale_version', status: 409 } },
    );
    expect(
      await insurance.renew(policy.value.id, {
        version: 2,
        startsOn: '2026-10-21',
        endsOn: '2027-10-20',
      }),
    ).toMatchObject({
      ok: true,
      value: { revision: 2, version: 3, status: 'valid', covering: false },
    });
    expect(await insurance.list({ status: 'expiring' })).toMatchObject({
      ok: true,
      value: { total: 0 },
    });
    expect(await insurance.list({ coversOn: '2026-10-06' })).toMatchObject({
      ok: true,
      value: { total: 0 },
    });
    expect(await insurance.history(policy.value.id, { limit: 25 })).toMatchObject({
      ok: true,
      value: { total: 2 },
    });
    expect(await insurance.archive(policy.value.id, 3)).toMatchObject({
      ok: true,
      value: { version: 4 },
    });
    expect(await insurance.get('desconocido')).toMatchObject({ ok: false, error: { status: 404 } });

    // Driver-vehicle assignments through the typed client.
    const assignments = createAssignmentsClient(client);
    const pilot = await employees.create({
      kind: 'driver',
      firstName: 'Rosa',
      lastName: 'Lopez',
      areaId: fleet.value.id,
      employeeNumber: 'E-ASG1',
    });
    const relief = await employees.create({
      kind: 'driver',
      firstName: 'Mario',
      lastName: 'Ruiz',
      areaId: fleet.value.id,
      employeeNumber: 'E-ASG2',
    });
    if (!pilot.ok || !relief.ok) throw new Error('driver fixtures failed');
    const assigned = await assignments.assign({
      vehicleId: truck.value.id,
      employeeId: pilot.value.id,
      type: 'principal',
      reason: 'Alta de unidad',
    });
    if (!assigned.ok) throw new Error('assignment failed');
    expect(assigned.value).toMatchObject({
      replaced: null,
      assignment: { current: true, version: 1, type: 'principal' },
    });
    expect(
      await assignments.assign({
        vehicleId: truck.value.id,
        employeeId: relief.value.id,
        type: 'principal',
        reason: 'Segundo',
      }),
    ).toMatchObject({
      ok: false,
      error: {
        code: 'principal_taken',
        status: 409,
        fieldErrors: [expect.objectContaining({ field: 'vehicle_id' })],
      },
    });
    expect(
      await assignments.assign({
        vehicleId: truck.value.id,
        employeeId: 'nope',
        type: 'temporary',
        reason: 'Prueba',
      }),
    ).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_employee',
        fieldErrors: [expect.objectContaining({ field: 'employee_id' })],
      },
    });
    const swapped = await assignments.assign({
      vehicleId: truck.value.id,
      employeeId: relief.value.id,
      type: 'principal',
      reason: 'Relevo',
      replace: true,
    });
    expect(swapped).toMatchObject({
      ok: true,
      value: {
        replaced: { id: assigned.value.assignment.id, endKind: 'replaced', current: false },
      },
    });
    expect(await assignments.list({ vehicleId: truck.value.id, status: 'current' })).toMatchObject({
      ok: true,
      value: { total: 1 },
    });
    expect(await assignments.list()).toMatchObject({ ok: true, value: { total: 2 } });
    expect(
      await assignments.end(assigned.value.assignment.id, { version: 2, reason: 'Otra vez' }),
    ).toMatchObject({ ok: false, error: { code: 'immutable', status: 409 } });
    if (!swapped.ok) throw new Error('replace failed');
    expect(
      await assignments.end(swapped.value.assignment.id, { version: 1, reason: 'Fin' }),
    ).toMatchObject({ ok: true, value: { current: false, endKind: 'ended', version: 2 } });
    expect(await assignments.get(swapped.value.assignment.id)).toMatchObject({ ok: true });
    expect(await assignments.history(assigned.value.assignment.id)).toMatchObject({
      ok: true,
      value: { total: 2 },
    });
    expect(await assignments.history(swapped.value.assignment.id, { limit: 25 })).toMatchObject({
      ok: true,
      value: { total: 2 },
    });
    expect(await assignments.get('desconocido')).toMatchObject({
      ok: false,
      error: { status: 404 },
    });

    // Drafts
    expect(await client.call('drafts.load', { params: { scope: 'form:a' } })).toEqual({
      ok: true,
      value: { draft: null },
    });
    const saved = await client.call('drafts.save', {
      params: { scope: 'form:a' },
      body: { values: { nota: 'texto' } },
    });
    expect(saved).toMatchObject({
      ok: true,
      value: { scope: 'form:a', values: { nota: 'texto' } },
    });
    expect(await client.call('drafts.load', { params: { scope: 'form:a' } })).toMatchObject({
      ok: true,
      value: { draft: { values: { nota: 'texto' } } },
    });
    expect(await client.call('drafts.discard', { params: { scope: 'form:a' } })).toEqual({
      ok: true,
      value: undefined,
    });

    // Invitation flow from another browser (pre-session CSRF), then sign out.
    const guest = trackedClient(world.handler);
    const token = issued[2] as string;
    expect(await guest.client.call('auth.invitation.inspect', { body: { token } })).toEqual({
      ok: true,
      value: { companyName: 'Empresa Alfa SA', roleLabel: 'Consulta' },
    });
    const accepted = await guest.client.call('auth.invitation.accept', {
      body: { token, ...world.credentials('subject-invitee') },
    });
    expect(accepted).toMatchObject({ ok: true, value: { roleId: 'viewer' } });
    expect(await guest.client.call('company.settings.get')).toMatchObject({
      ok: false,
      error: { code: 'forbidden', status: 403 },
    });
    expect(await guest.client.call('auth.logout')).toEqual({ ok: true, value: undefined });
    expect(await guest.client.call('auth.session')).toMatchObject({
      ok: false,
      error: { code: 'unauthorized', status: 401 },
    });
    expect(await client.call('auth.logout')).toEqual({ ok: true, value: undefined });
    expect(await client.call('users.list')).toMatchObject({ ok: false, error: { status: 401 } });

    // The CSRF endpoint is exercised by the handshake itself.
    for (const id of guest.used) used.add(id);
    used.add('auth.csrf');
    expect([...used].sort()).toEqual([...bffRouteIds].sort());
  });

  it('refreshes its session token after a reload and keeps working', async () => {
    world = createBffWorld();
    await world.tenant('Empresa Alfa', 'subject-admin');
    const fetch = browserFetch(world.handler);
    const before = createBffClient({ fetch });
    await before.call('auth.login', { body: world.credentials('subject-admin') });
    // A new page load: same cookie jar, a client with no memory of the CSRF token.
    const after = createBffClient({ fetch });
    expect(await after.call('users.invite', { body: { roleId: 'editor' } })).toMatchObject({
      ok: true,
      value: { user: { roleId: 'editor' } },
    });
  });

  it('maps every uniform BFF failure to the shared error shape', async () => {
    world = createBffWorld();
    await world.tenant('Empresa Alfa', 'subject-admin');
    await world.member('subject-admin', 'viewer', 'subject-viewer');
    const { client } = trackedClient(world.handler);
    const bad = await client.call('auth.login', { body: { code: 'desconocido', nonce: 'n' } });
    expect(bad).toMatchObject({ ok: false, error: { code: 'unauthorized', status: 401 } });
    await client.call('auth.login', { body: world.credentials('subject-viewer') });
    const denied = await client.call('users.list');
    expect(denied).toMatchObject({ ok: false, error: { code: 'forbidden', status: 403 } });
    if (denied.ok) throw new Error('expected failure');
    expect(Object.keys(denied.error).sort()).toEqual([
      'code',
      'correlationId',
      'message',
      'status',
    ]);
    expect(denied.error.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      await client.call('users.deactivate', { params: { id: 'x' }, body: { reason: 'r' } }),
    ).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });
  });

  it('does not replay a write into another company when a second tab changed the shared session', async () => {
    world = createBffWorld();
    await world.tenant('Empresa Alfa', 'subject-admin-a');
    await world.tenant('Empresa Beta', 'subject-admin-b');
    // Two tabs of one browser: one cookie jar, two page contexts (two clients).
    const fetch = browserFetch(world.handler);
    const tabA = createBffClient({ fetch });
    const tabB = createBffClient({ fetch });
    expect(
      await tabA.call('auth.login', { body: world.credentials('subject-admin-a') }),
    ).toMatchObject({
      ok: true,
      value: { company: { name: 'Empresa Alfa' } },
    });
    expect(
      await tabB.call('auth.login', { body: world.credentials('subject-admin-b') }),
    ).toMatchObject({
      ok: true,
      value: { company: { name: 'Empresa Beta' } },
    });
    // Tab A still believes it is Alfa's administrator.
    const write = await tabA.call('drafts.save', {
      params: { scope: 'form' },
      body: { values: { nota: 'de Alfa' } },
    });
    expect(write).toMatchObject({ ok: false, error: { code: 'unauthorized', status: 401 } });
    const rename = await tabA.call('company.settings.update', {
      body: { name: 'Renombrada desde Alfa', mfa: 'optional', sessionIdleHours: 8 },
    });
    expect(rename).toMatchObject({ ok: false, error: { status: 401 } });
    // Nothing reached Beta.
    expect(await tabB.call('drafts.load', { params: { scope: 'form' } })).toEqual({
      ok: true,
      value: { draft: null },
    });
    expect(await tabB.call('company.settings.get')).toMatchObject({
      ok: true,
      value: { name: 'Empresa Beta' },
    });
  });
});
