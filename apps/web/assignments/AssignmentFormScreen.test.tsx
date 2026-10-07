import { act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createMockApi, demoSubjects } from '../app/mockApi';
import {
  click,
  deferred,
  fireEvent,
  getField,
  renderApp,
  screen,
  type,
  waitFor,
} from '../app/test/utils';
import type { ApiError, Result } from '../app/types';
import { makeVehicle } from '../vehicles/fixtures';
import { describeFailure } from './AssignmentFormScreen';
import { closed, makeAssignment } from './fixtures';

const apiError = (status: ApiError['status'], code: string, field?: string): ApiError => ({
  code,
  status,
  message: 'x',
  correlationId: 'c',
  ...(field ? { fieldErrors: [{ field, code, message: 'x' }] } : {}),
});
const fail = (status: ApiError['status'], code: string, field?: string): Result<never> => ({
  ok: false,
  error: apiError(status, code, field),
});
const choose = (label: string, value: string) =>
  fireEvent.change(getField(label), { target: { value } });

async function openCreate(options: Parameters<typeof renderApp>[0] = {}) {
  const view = await renderApp({ path: '/flota/asignaciones/nueva', ...options });
  await screen.findByRole('heading', { name: 'Nueva asignación', level: 1 });
  await screen.findByRole('option', { name: /ECO-001 · Nissan NP300/ });
  await screen.findByRole('option', { name: /Ana García López · E-0001/ });
  return view;
}

function fill(values: Record<string, string> = {}) {
  const all: Record<string, string> = {
    Vehículo: 'veh-005',
    Conductor: 'emp-010',
    Tipo: 'principal',
    'Motivo de la asignación': 'Ruta de prueba',
    ...values,
  };
  for (const [label, value] of Object.entries(all))
    if (label === 'Motivo de la asignación') type(label, value);
    else choose(label, value);
}

describe('describeFailure', () => {
  it('says which business rule a conflict broke, and offers to replace only to who can', () => {
    const vehicle = describeFailure(apiError(409, 'principal_taken', 'vehicle_id'), 'assign', true);
    expect(vehicle.alert).toMatchObject({
      title: 'El vehículo ya tiene un conductor principal',
      actionLabel: 'Reemplazar al principal actual',
    });
    expect(vehicle.alert?.message).toMatch(/BR-002/);
    const noEdit = describeFailure(apiError(409, 'principal_taken', 'vehicle_id'), 'assign', false);
    expect(noEdit.alert?.actionLabel).toBeUndefined();
    expect(noEdit.alert?.message).toMatch(/permiso para editar/);
    const driver = describeFailure(apiError(409, 'principal_taken', 'employee_id'), 'assign', true);
    expect(driver.alert).toMatchObject({ title: 'El conductor ya es principal de otro vehículo' });
    expect(driver.alert?.message).toMatch(/BR-003/);
    expect(driver.fields.employeeId).toBe('Este conductor ya es el principal de otro vehículo.');
    expect(describeFailure(apiError(409, 'already_assigned', 'employee_id'), 'assign').alert?.title).toBe(
      'El conductor ya está asignado a este vehículo',
    );
    const ineligible = describeFailure(apiError(422, 'invalid_vehicle', 'vehicle_id'), 'assign');
    expect(ineligible.alert?.message).toMatch(/BR-014/);
    expect(ineligible.fields.vehicleId).toBeDefined();
    expect(describeFailure(apiError(422, 'invalid_employee', 'employee_id'), 'assign').alert?.title).toBe(
      'El conductor no se puede asignar',
    );
  });

  it('explains the other failures and shows nothing for an expired session', () => {
    expect(describeFailure(apiError(401, 'unauthorized'), 'assign')).toEqual({ alert: null, fields: {} });
    expect(describeFailure(apiError(409, 'stale_version'), 'end').alert?.actionLabel).toBe(
      'Cargar datos actuales',
    );
    expect(describeFailure(apiError(409, 'immutable'), 'end').alert?.title).toBe(
      'La asignación ya estaba cerrada',
    );
    expect(describeFailure(apiError(400, 'bad_request'), 'assign').alert?.title).toBe(
      'El servidor rechazó los datos',
    );
    expect(describeFailure(apiError(403, 'forbidden'), 'assign').alert?.message).toMatch(/crear y para editar/);
    expect(describeFailure(apiError(403, 'forbidden'), 'end').alert?.message).toMatch(/cerrar asignaciones/);
    expect(describeFailure(apiError(404, 'not_found'), 'end').alert?.title).toBe('La asignación ya no existe');
    expect(describeFailure(apiError(500, 'internal_error'), 'end').alert?.title).toBe(
      'No pudimos cerrar la asignación',
    );
    expect(describeFailure(apiError(500, 'internal_error'), 'assign').alert?.title).toBe(
      'No pudimos crear la asignación',
    );
  });
});

describe('assign a driver', () => {
  it('explains every missing field, focuses the first one and does not call the API', async () => {
    const api = createMockApi();
    const assign = vi.spyOn(api.assignments, 'assign');
    await openCreate({ api });
    click('Crear asignación');
    for (const message of ['Elige el vehículo.', 'Elige el conductor.', 'Escribe el motivo de la asignación.'])
      expect(screen.getByText(message)).toBeInTheDocument();
    expect(getField('Vehículo')).toHaveFocus();
    expect(getField('Vehículo')).toHaveAttribute('aria-invalid', 'true');
    expect(assign).not.toHaveBeenCalled();
    choose('Vehículo', 'veh-005');
    expect(screen.queryByText('Elige el vehículo.')).toBeNull();
  });

  it('offers only eligible vehicles and active drivers (BR-014)', async () => {
    await openCreate();
    const vehicles = screen.getByLabelText(/^Vehículo/);
    const options = Array.from(vehicles.querySelectorAll('option')).map((option) => option.value);
    // veh-007 is inactive and veh-008 decommissioned in the demo fleet.
    expect(options).toContain('veh-005');
    expect(options).not.toContain('veh-007');
    expect(options).not.toContain('veh-008');
    const drivers = Array.from(screen.getByLabelText(/^Conductor/).querySelectorAll('option')).map(
      (option) => option.value,
    );
    // emp-005 is a suspended driver, emp-003 a dispatcher.
    expect(drivers).toContain('emp-010');
    expect(drivers).not.toContain('emp-005');
    expect(drivers).not.toContain('emp-003');
  });

  it('assigns, sending a normalized reason and no replace flag, and opens the detail with a confirmation', async () => {
    const api = createMockApi();
    const assign = vi.spyOn(api.assignments, 'assign');
    await openCreate({ api });
    fill({ 'Motivo de la asignación': '  Ruta   de prueba ' });
    click('Crear asignación');
    expect(await screen.findByText('Asignación creada.')).toBeInTheDocument();
    expect(assign).toHaveBeenCalledWith({
      vehicleId: 'veh-005',
      employeeId: 'emp-010',
      type: 'principal',
      reason: 'Ruta de prueba',
    });
    await waitFor(() => expect(window.location.search).toBe(''));
    expect(window.location.pathname).toMatch(/^\/flota\/asignaciones\/asg-nueva-/);
    expect(api.controls.assignments()).toHaveLength(29);
  });

  it('opens with the vehicle or the driver chosen on the previous screen', async () => {
    await renderApp({ path: '/flota/asignaciones/nueva?vehiculo=veh-005&conductor=emp-010' });
    await screen.findByRole('option', { name: /ECO-005/ });
    expect(getField('Vehículo')).toHaveValue('veh-005');
    expect(getField('Conductor')).toHaveValue('emp-010');
  });

  it('puts the BR-002 conflict in an alert and replaces the principal when the person accepts', async () => {
    const api = createMockApi();
    const assign = vi.spyOn(api.assignments, 'assign');
    await openCreate({ api });
    fill({ Vehículo: 'veh-001', Conductor: 'emp-010' });
    click('Crear asignación');
    expect(
      await screen.findByRole('heading', { name: 'El vehículo ya tiene un conductor principal' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/BR-002/)).toBeInTheDocument();
    expect(assign).toHaveBeenCalledTimes(1);
    click('Reemplazar al principal actual');
    expect(await screen.findByText(/La principal anterior se cerró/)).toBeInTheDocument();
    expect(assign).toHaveBeenLastCalledWith({
      vehicleId: 'veh-001',
      employeeId: 'emp-010',
      type: 'principal',
      reason: 'Ruta de prueba',
      replace: true,
    });
    const snapshot = api.controls.assignments();
    expect(snapshot.find((item) => item.id === 'asg-001')).toMatchObject({
      endKind: 'replaced',
      current: false,
    });
  });

  it('replaces from the start with the checkbox, and warns what it will do', async () => {
    const api = createMockApi();
    const assign = vi.spyOn(api.assignments, 'assign');
    await openCreate({ api });
    fill({ Vehículo: 'veh-001', Conductor: 'emp-010' });
    fireEvent.click(screen.getByRole('checkbox', { name: /Reemplazar al conductor principal actual/ }));
    expect(screen.getByText(/se cerrará con la fecha de hoy/)).toBeInTheDocument();
    click('Crear asignación');
    await screen.findByText(/La principal anterior se cerró/);
    expect(assign.mock.calls[0]?.[0]).toMatchObject({ replace: true });
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it('hides the replace option for a secondary assignment, and does not send it', async () => {
    const api = createMockApi();
    const assign = vi.spyOn(api.assignments, 'assign');
    await openCreate({ api });
    fireEvent.click(screen.getByRole('checkbox', { name: /Reemplazar/ }));
    choose('Tipo', 'secondary');
    expect(screen.queryByRole('checkbox')).toBeNull();
    fill({ Tipo: 'secondary', Vehículo: 'veh-001', Conductor: 'emp-010' });
    click('Crear asignación');
    await screen.findByText('Asignación creada.');
    expect(Object.hasOwn(assign.mock.calls[0]?.[0] ?? {}, 'replace')).toBe(false);
  });

  it('does not offer to replace to a role without edit, and says why', async () => {
    const api = createMockApi();
    await openCreate({ api, account: 'piiReader' });
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByText(/reemplazarlo requiere permiso para editar/)).toBeInTheDocument();
    fill({ Vehículo: 'veh-001', Conductor: 'emp-010' });
    click('Crear asignación');
    expect(
      await screen.findByRole('heading', { name: 'El vehículo ya tiene un conductor principal' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reemplazar al principal actual' })).toBeNull();
    expect(screen.getByText(/permiso para editar que lo reemplace/)).toBeInTheDocument();
  });

  it('explains the BR-003 conflict next to the driver and focuses it', async () => {
    await openCreate();
    // emp-001 is the principal of veh-001 in the demo data.
    fill({ Vehículo: 'veh-005', Conductor: 'emp-001' });
    click('Crear asignación');
    expect(
      await screen.findByRole('heading', { name: 'El conductor ya es principal de otro vehículo' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Este conductor ya es el principal de otro vehículo.')).toBeInTheDocument();
    await waitFor(() => expect(getField('Conductor')).toHaveFocus());
    expect(screen.queryByRole('button', { name: 'Reemplazar al principal actual' })).toBeNull();
  });

  it('refuses a driver already assigned to the vehicle, and an ineligible vehicle (BR-014) uniformly', async () => {
    const api = createMockApi();
    await openCreate({ api });
    fill({ Tipo: 'secondary', Vehículo: 'veh-001', Conductor: 'emp-006' });
    click('Crear asignación');
    expect(
      await screen.findByRole('heading', { name: 'El conductor ya está asignado a este vehículo' }),
    ).toBeInTheDocument();
    // The vehicle goes inactive after the form was loaded: the server answers the same 422 as for any other cause.
    await api.vehicles.update('veh-005', { version: 1, make: 'Otra' });
    api.assignments.assign = async () => fail(422, 'invalid_vehicle', 'vehicle_id');
    fill({ Vehículo: 'veh-005', Conductor: 'emp-010' });
    click('Crear asignación');
    expect(await screen.findByRole('heading', { name: 'El vehículo no se puede asignar' })).toBeInTheDocument();
    expect(screen.getByText(/archivado, inactivo o dado de baja/)).toBeInTheDocument();
    await waitFor(() => expect(getField('Vehículo')).toHaveFocus());
  });

  it('blocks a second submit while saving', async () => {
    const api = createMockApi();
    const real = api.assignments.assign;
    const gate = deferred();
    let calls = 0;
    api.assignments.assign = async (input) => {
      calls += 1;
      await gate.promise;
      return real(input);
    };
    await openCreate({ api });
    fill();
    click('Crear asignación');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cargando…' })).toBeDisabled());
    fireEvent.submit(screen.getByRole('form', { name: 'Nueva asignación' }));
    expect(calls).toBe(1);
    await act(async () => gate.resolve());
    await screen.findByText('Asignación creada.');
  });

  it.each([
    [400, 'bad_request', 'El servidor rechazó los datos'],
    [403, 'forbidden', 'No tienes permiso'],
    [500, 'internal_error', 'No pudimos crear la asignación'],
  ] as const)('shows a %s failure without losing the form', async (status, code, title) => {
    const api = createMockApi();
    api.assignments.assign = async () => fail(status, code);
    await openCreate({ api });
    fill();
    click('Crear asignación');
    expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument();
    expect(getField('Motivo de la asignación')).toHaveValue('Ruta de prueba');
  });

  it('keeps what was typed when the session expires, and saves after signing in again', async () => {
    const { api } = await openCreate();
    fill();
    api.controls.expireSession();
    click('Crear asignación');
    await screen.findByRole('group', { name: 'Sesión expirada' });
    expect(getField('Motivo de la asignación')).toHaveValue('Ruta de prueba');
    type('Cuenta de prueba', demoSubjects.admin);
    click('Continuar');
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Sesión expirada' })).toBeNull());
    click('Crear asignación');
    await screen.findByText('Asignación creada.');
  });

  it('offers a retry when the vehicles or the drivers cannot be loaded, and invites to register them when there are none', async () => {
    const api = createMockApi();
    api.controls.failNext('listVehicles');
    const failed = await renderApp({ api, path: '/flota/asignaciones/nueva' });
    expect(await screen.findByRole('heading', { name: 'No pudimos cargar la información' })).toBeInTheDocument();
    click('Reintentar');
    await screen.findByRole('option', { name: /ECO-001/ });
    failed.unmount();
    const drivers = createMockApi();
    drivers.controls.failNext('listEmployees');
    const noDrivers = await renderApp({ api: drivers, path: '/flota/asignaciones/nueva' });
    expect(await screen.findByRole('heading', { name: 'No pudimos cargar la información' })).toBeInTheDocument();
    noDrivers.unmount();
    const empty = await renderApp({
      api: createMockApi({ vehicles: [], employees: [] }),
      path: '/flota/asignaciones/nueva',
    });
    expect(await screen.findByRole('heading', { name: 'No hay vehículos disponibles' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'No hay conductores disponibles' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Registrar un conductor nuevo' })).toHaveAttribute(
      'href',
      '/plantilla/empleados/nuevo',
    );
    empty.unmount();
  });

  it('says when only part of the fleet is offered, cancels back to the list and is closed to a role without create', async () => {
    const vehicles = Array.from({ length: 501 }, (_, index) =>
      makeVehicle({ id: `v${index}`, economicNumber: `E-${String(index).padStart(4, '0')}`, plate: `P-${index}` }),
    );
    const big = await renderApp({ api: createMockApi({ vehicles }), path: '/flota/asignaciones/nueva' });
    expect(await screen.findByText('Se muestran los primeros vehículos del listado.')).toBeInTheDocument();
    big.unmount();
    const view = await openCreate();
    fireEvent.click(screen.getByRole('link', { name: 'Cancelar' }));
    await screen.findByRole('heading', { name: 'Asignaciones', level: 1 });
    expect(window.location.pathname).toBe('/flota/asignaciones');
    view.unmount();
    await renderApp({ account: 'mechanic', path: '/flota/asignaciones/nueva' });
    expect(await screen.findByRole('heading', { name: 'No tienes acceso' })).toBeInTheDocument();
  });
});

describe('close an assignment', () => {
  const end = (api = createMockApi(), id = 'asg-001', account: 'admin' | 'viewer' | 'piiReader' = 'admin') =>
    renderApp({ api, account, path: `/flota/asignaciones/${id}/cerrar` });

  it('shows what is being closed and explains that it cannot be undone', async () => {
    await end();
    await screen.findByRole('heading', { name: 'Cerrar asignación', level: 1 });
    const form = await screen.findByRole('form', { name: 'Cerrar asignación' });
    expect(screen.getByText(/no se puede deshacer/)).toBeInTheDocument();
    await waitFor(() => expect(form).toHaveTextContent('ECO-001'));
    await waitFor(() => expect(form).toHaveTextContent('Ana García López'));
    expect(form).toHaveTextContent('Principal');
    expect(screen.queryByLabelText(/Vehículo/)).toBeNull();
  });

  it('requires a reason, then closes with the version it loaded and shows the result on the detail', async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api.assignments, 'end');
    await end(api);
    await screen.findByRole('textbox', { name: /Motivo del cierre/ });
    click('Cerrar asignación');
    expect(screen.getByText('Escribe el motivo del cierre.')).toBeInTheDocument();
    expect(getField('Motivo del cierre')).toHaveFocus();
    expect(spy).not.toHaveBeenCalled();
    type('Motivo del cierre', ' Fin   de ruta ');
    click('Cerrar asignación');
    expect(await screen.findByText(/Asignación cerrada\. Quedó en el historial/)).toBeInTheDocument();
    expect(spy).toHaveBeenCalledWith('asg-001', { version: 1, reason: 'Fin de ruta' });
    expect(window.location.pathname).toBe('/flota/asignaciones/asg-001');
    expect(screen.getByRole('heading', { name: 'Asignación cerrada' })).toBeInTheDocument();
  });

  it('tells the person when someone else closed it meanwhile', async () => {
    const { api } = await end();
    await screen.findByRole('textbox', { name: /Motivo del cierre/ });
    api.controls.endAssignmentExternally('asg-001');
    type('Motivo del cierre', 'Mi motivo');
    click('Cerrar asignación');
    expect(await screen.findByRole('heading', { name: 'La asignación ya estaba cerrada' })).toBeInTheDocument();
  });

  it('on a stale version offers the current data and starts over from the server', async () => {
    const api = createMockApi();
    const real = api.assignments.end;
    let stale = true;
    api.assignments.end = async (id, input) => (stale ? fail(409, 'stale_version') : real(id, input));
    await end(api);
    await screen.findByRole('textbox', { name: /Motivo del cierre/ });
    type('Motivo del cierre', 'Mi motivo');
    click('Cerrar asignación');
    expect(await screen.findByRole('heading', { name: 'Otra persona modificó esta asignación' })).toBeInTheDocument();
    stale = false;
    click('Cargar datos actuales');
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Otra persona modificó esta asignación' })).toBeNull());
    // Loading the current data starts over: the person decides again.
    await waitFor(() => expect(getField('Motivo del cierre')).toHaveValue(''));
  });

  it('shows a read-only record when the assignment was closed while the person was deciding', async () => {
    const api = createMockApi();
    await end(api);
    await screen.findByRole('textbox', { name: /Motivo del cierre/ });
    type('Motivo del cierre', 'Escrito antes');
    await act(async () => {
      // Another actor replaces the principal: the assignment is closed and its version moves on.
      await api.assignments.assign({
        vehicleId: 'veh-001',
        employeeId: 'emp-010',
        type: 'principal',
        reason: 'Otra',
        replace: true,
      });
    });
    api.assignments.end = async () => fail(409, 'stale_version');
    click('Cerrar asignación');
    await screen.findByRole('heading', { name: 'Otra persona modificó esta asignación' });
    // The old assignment is closed now: reloading it shows a read-only record.
    click('Cargar datos actuales');
    expect(await screen.findByRole('heading', { name: 'Esta asignación ya está cerrada' })).toBeInTheDocument();
  });

  it('is read-only for a closed assignment, and for an unknown one', async () => {
    const closedOne = await end(createMockApi({ assignments: [closed(makeAssignment())] }));
    expect(await screen.findByRole('heading', { name: 'Esta asignación ya está cerrada' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Volver a la asignación' })).toHaveAttribute(
      'href',
      '/flota/asignaciones/asg-001',
    );
    closedOne.unmount();
    const missing = await end(createMockApi(), 'no-existe');
    expect(await screen.findByRole('heading', { name: 'Asignación no encontrada' })).toBeInTheDocument();
    missing.unmount();
    const failed = createMockApi();
    failed.controls.failNext('getAssignment');
    await end(failed);
    expect(await screen.findByRole('heading', { name: 'No pudimos cargar la información' })).toBeInTheDocument();
  });

  it.each([
    [400, 'bad_request', 'El servidor rechazó los datos'],
    [403, 'forbidden', 'No tienes permiso'],
    [404, 'not_found', 'La asignación ya no existe'],
    [500, 'internal_error', 'No pudimos cerrar la asignación'],
  ] as const)('shows a %s failure without losing the reason', async (status, code, title) => {
    const api = createMockApi();
    api.assignments.end = async () => fail(status, code);
    await end(api);
    await screen.findByRole('textbox', { name: /Motivo del cierre/ });
    type('Motivo del cierre', 'Mi motivo');
    click('Cerrar asignación');
    expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument();
    expect(getField('Motivo del cierre')).toHaveValue('Mi motivo');
  });

  it('is closed to roles without edit, and expires the session on a 401', async () => {
    const viewer = await end(createMockApi(), 'asg-001', 'piiReader');
    expect(await screen.findByRole('heading', { name: 'No tienes acceso' })).toBeInTheDocument();
    viewer.unmount();
    const { api } = await end();
    await screen.findByRole('textbox', { name: /Motivo del cierre/ });
    type('Motivo del cierre', 'Mi motivo');
    api.controls.expireSession();
    click('Cerrar asignación');
    await screen.findByRole('group', { name: 'Sesión expirada' });
    expect(getField('Motivo del cierre')).toHaveValue('Mi motivo');
  });
});
