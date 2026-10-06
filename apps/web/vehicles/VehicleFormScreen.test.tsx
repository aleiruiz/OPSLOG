import { act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createMockApi, demoSubjects } from '../app/mockApi';
import { click, deferred, getField, renderApp, screen, type, waitFor } from '../app/test/utils';
import type { ApiError, Result, Vehicle } from '../app/types';
import { demoVehicles, makeVehicle } from './fixtures';
import { describeFailure } from './VehicleFormScreen';

const apiError = (
  status: ApiError['status'],
  code: string,
  fieldErrors?: ApiError['fieldErrors'],
): ApiError => ({
  code,
  status,
  message: 'x',
  correlationId: 'c',
  ...(fieldErrors ? { fieldErrors } : {}),
});
const error = (status: ApiError['status'], code: string): Result<Vehicle> => ({
  ok: false,
  error: apiError(status, code),
});

function fillCreate(overrides: Record<string, string> = {}) {
  const values: Record<string, string> = {
    'Número económico': 'ECO-900',
    Placa: 'zz 900',
    Marca: 'Toyota',
    Modelo: 'Hiace',
    Año: '2023',
    'Identificador de área': 'area-sur',
    Odómetro: '1200',
    ...overrides,
  };
  for (const [label, value] of Object.entries(values)) type(label, value);
}

describe('create vehicle', () => {
  it('explains every missing field, focuses the first one and does not call the API', async () => {
    const api = createMockApi();
    const create = vi.spyOn(api.vehicles, 'create');
    await renderApp({ api, path: '/flota/vehiculos/nuevo' });
    await screen.findByRole('heading', { name: 'Nuevo vehículo', level: 1 });
    click('Crear vehículo');
    expect(screen.getByText('Escribe el número económico.')).toBeInTheDocument();
    expect(screen.getByText('Escribe la placa.')).toBeInTheDocument();
    expect(screen.getByText('Escribe el año del modelo.')).toBeInTheDocument();
    expect(getField('Número económico')).toHaveFocus();
    expect(getField('Número económico')).toHaveAttribute('aria-invalid', 'true');
    expect(getField('Número económico')).toHaveAccessibleDescription(
      'Escribe el número económico.',
    );
    expect(create).not.toHaveBeenCalled();
    // Correcting a field clears its message.
    type('Número económico', 'ECO-900');
    expect(screen.queryByText('Escribe el número económico.')).toBeNull();
    expect(getField('Fecha de alta')).toHaveValue(new Date().toISOString().slice(0, 10));
  });

  it('creates the vehicle with normalized values and opens its detail with a confirmation', async () => {
    const api = createMockApi();
    const create = vi.spyOn(api.vehicles, 'create');
    await renderApp({ api, path: '/flota/vehiculos/nuevo' });
    await screen.findByRole('heading', { name: 'Nuevo vehículo', level: 1 });
    fillCreate({ VIN: '3n6pd23w99zb19999' });
    click('Crear vehículo');
    expect(
      await screen.findByRole('heading', { name: 'Vehículo ECO-900', level: 1 }),
    ).toBeInTheDocument();
    expect(create).toHaveBeenCalledWith({
      economicNumber: 'ECO-900',
      plate: 'ZZ 900',
      vin: '3N6PD23W99ZB19999',
      make: 'Toyota',
      model: 'Hiace',
      year: 2023,
      areaId: 'area-sur',
      odometerKm: 1200,
      registeredOn: new Date().toISOString().slice(0, 10),
    });
    expect(screen.getByText('Vehículo creado.')).toBeInTheDocument();
    await waitFor(() => expect(window.location.search).toBe(''));
    expect(window.location.pathname).toMatch(/^\/flota\/vehiculos\/veh-nuevo-/);
    expect(screen.getByText('ZZ 900')).toBeInTheDocument();
    expect(api.controls.vehicles()).toHaveLength(29);
  });

  it.each([
    [
      'número económico',
      { 'Número económico': 'eco-001', Placa: 'NEW 1' },
      'Número económico',
      'Ya existe un vehículo con este número económico.',
    ],
    ['placa', { Placa: 'abc101' }, 'Placa', 'Ya existe un vehículo con esta placa.'],
  ])(
    'puts a duplicate %s next to its field and focuses it',
    async (_name, change, label, message) => {
      await renderApp({ path: '/flota/vehiculos/nuevo' });
      await screen.findByRole('heading', { name: 'Nuevo vehículo', level: 1 });
      fillCreate(change);
      click('Crear vehículo');
      expect(await screen.findByText(message)).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'Hay datos que ya existen' })).toBeInTheDocument();
      await waitFor(() => expect(getField(label)).toHaveFocus());
      expect(getField(label)).toHaveAttribute('aria-invalid', 'true');
    },
  );

  it('reports a duplicate VIN', async () => {
    const api = createMockApi({ vehicles: [makeVehicle({ vin: '3N6PD23W05ZB10005' })] });
    await renderApp({ api, path: '/flota/vehiculos/nuevo' });
    await screen.findByRole('heading', { name: 'Nuevo vehículo', level: 1 });
    fillCreate({ VIN: '3N6PD23W05ZB10005' });
    click('Crear vehículo');
    expect(await screen.findByText('Ya existe un vehículo con este VIN.')).toBeInTheDocument();
    await waitFor(() => expect(getField('VIN')).toHaveFocus());
  });

  it.each([
    [400, 'bad_request', 'El servidor rechazó los datos'],
    [403, 'forbidden', 'No tienes permiso'],
    [500, 'internal_error', 'No pudimos guardar el vehículo'],
  ] as const)(
    'shows a %s answer as an alert that keeps what was typed',
    async (status, code, title) => {
      const api = createMockApi();
      api.vehicles.create = async () => error(status, code);
      await renderApp({ api, path: '/flota/vehiculos/nuevo' });
      await screen.findByRole('heading', { name: 'Nuevo vehículo', level: 1 });
      fillCreate();
      click('Crear vehículo');
      expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument();
      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(getField('Marca')).toHaveValue('Toyota');
      await waitFor(() =>
        expect(
          screen.getByRole('heading', { name: title }).closest('[tabindex="-1"]'),
        ).toHaveFocus(),
      );
    },
  );

  it('blocks a second submit while the first is running', async () => {
    const api = createMockApi();
    const real = api.vehicles.create;
    const gate = deferred();
    const create = vi.fn(async (input: Parameters<typeof real>[0]) => {
      await gate.promise;
      return real(input);
    });
    api.vehicles.create = create;
    await renderApp({ api, path: '/flota/vehiculos/nuevo' });
    await screen.findByRole('heading', { name: 'Nuevo vehículo', level: 1 });
    fillCreate();
    click('Crear vehículo');
    const busy = await screen.findByRole('button', { name: 'Cargando…' });
    expect(busy).toBeDisabled();
    screen
      .getByRole('form', { name: 'Nuevo vehículo' })
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await act(async () => gate.resolve());
    await screen.findByRole('heading', { name: 'Vehículo ECO-900', level: 1 });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('keeps the form and what was typed when the session expires, and saves after signing in again', async () => {
    const { api } = await renderApp({ path: '/flota/vehiculos/nuevo' });
    await screen.findByRole('heading', { name: 'Nuevo vehículo', level: 1 });
    fillCreate();
    api.controls.expireSession();
    click('Crear vehículo');
    await screen.findByRole('group', { name: 'Sesión expirada' });
    expect(screen.queryByRole('heading', { name: 'No pudimos guardar el vehículo' })).toBeNull();
    type('Cuenta de prueba', demoSubjects.admin);
    click('Continuar');
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: 'Sesión expirada' })).toBeNull(),
    );
    expect(getField('Marca')).toHaveValue('Toyota');
    click('Crear vehículo');
    expect(
      await screen.findByRole('heading', { name: 'Vehículo ECO-900', level: 1 }),
    ).toBeInTheDocument();
  });

  it('cancels back to the list, and is not available to a role without create permission', async () => {
    const dispatch = await renderApp({ account: 'dispatch', path: '/flota/vehiculos/nuevo' });
    await screen.findByRole('heading', { name: 'Nuevo vehículo', level: 1 });
    expect(screen.getByRole('link', { name: 'Cancelar' })).toHaveAttribute(
      'href',
      '/flota/vehiculos',
    );
    dispatch.unmount();
    const api = createMockApi();
    const create = vi.spyOn(api.vehicles, 'create');
    await renderApp({ api, account: 'viewer', path: '/flota/vehiculos/nuevo' });
    expect(await screen.findByRole('heading', { name: 'No tienes acceso' })).toBeInTheDocument();
    expect(screen.queryByRole('form')).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });
});

describe('edit vehicle', () => {
  const edit = (
    api = createMockApi(),
    id = 'veh-001',
    account: 'admin' | 'dispatch' | 'viewer' = 'admin',
  ) => renderApp({ api, account, path: `/flota/vehiculos/${id}/editar` });
  const ready = () => screen.findByRole('heading', { name: 'Editar vehículo', level: 1 });

  it('opens with the loaded values and explains the odometer rule', async () => {
    const seed = [makeVehicle({ vin: '3N6PD23W99ZB19999', odometerKm: 48250 })];
    await edit(createMockApi({ vehicles: seed }));
    await ready();
    expect(await screen.findByDisplayValue('ECO-001')).toBeInTheDocument();
    expect(getField('Placa')).toHaveValue('ABC-101');
    expect(getField('VIN')).toHaveValue('3N6PD23W99ZB19999');
    expect(getField('Odómetro actual')).toHaveValue('48250');
    expect(getField('Odómetro actual')).toHaveAccessibleDescription(
      'Lectura actual: 48,250 km. Solo puede aumentar.',
    );
    expect(screen.queryByLabelText(/Fecha de alta/)).toBeNull();
    expect(screen.getByRole('link', { name: 'Cancelar' })).toHaveAttribute(
      'href',
      '/flota/vehiculos/veh-001',
    );
  });

  it('does not call the API when nothing changed', async () => {
    const api = createMockApi();
    const update = vi.spyOn(api.vehicles, 'update');
    const odometer = vi.spyOn(api.vehicles, 'recordOdometer');
    await edit(api);
    await screen.findByDisplayValue('ECO-001');
    click('Guardar cambios');
    expect(await screen.findByText('No hay cambios que guardar.')).toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
    expect(odometer).not.toHaveBeenCalled();
  });

  it('sends only the changed fields with the version it loaded', async () => {
    const api = createMockApi();
    const update = vi.spyOn(api.vehicles, 'update');
    const odometer = vi.spyOn(api.vehicles, 'recordOdometer');
    await edit(api);
    await screen.findByDisplayValue('ECO-001');
    type('Marca', ' Toyota ');
    type('VIN', '3n6pd23w99zb19999');
    click('Guardar cambios');
    expect(
      await screen.findByRole('heading', { name: 'Vehículo ECO-001', level: 1 }),
    ).toBeInTheDocument();
    expect(update).toHaveBeenCalledWith('veh-001', {
      version: 1,
      make: 'Toyota',
      vin: '3N6PD23W99ZB19999',
    });
    expect(odometer).not.toHaveBeenCalled();
    expect(screen.getByText('Cambios guardados.')).toBeInTheDocument();
    expect(screen.getByText('3N6PD23W99ZB19999')).toBeInTheDocument();
  });

  it('records a higher odometer through its own command, after the field changes, with the new version', async () => {
    const api = createMockApi();
    const update = vi.spyOn(api.vehicles, 'update');
    const odometer = vi.spyOn(api.vehicles, 'recordOdometer');
    await edit(api);
    await screen.findByDisplayValue('ECO-001');
    type('Odómetro actual', '16000');
    click('Guardar cambios');
    await screen.findByRole('heading', { name: 'Vehículo ECO-001', level: 1 });
    expect(update).not.toHaveBeenCalled();
    expect(odometer).toHaveBeenCalledWith('veh-001', { version: 1, odometerKm: 16000 });
    expect(screen.getByText('16,000 km')).toBeInTheDocument();
  });

  it('saves field changes and the odometer together', async () => {
    const api = createMockApi();
    const odometer = vi.spyOn(api.vehicles, 'recordOdometer');
    await edit(api);
    await screen.findByDisplayValue('ECO-001');
    type('Modelo', 'Frontier');
    type('Año', '2024');
    type('Identificador de área', 'area-sur');
    type('Número económico', 'ECO-777');
    type('Odómetro actual', '17000');
    click('Guardar cambios');
    await screen.findByRole('heading', { name: 'Vehículo ECO-777', level: 1 });
    expect(odometer).toHaveBeenCalledWith('veh-001', { version: 2, odometerKm: 17000 });
    expect(api.controls.vehicles()[0]).toMatchObject({
      model: 'Frontier',
      year: 2024,
      areaId: 'area-sur',
      odometerKm: 17000,
      version: 3,
    });
  });

  it('refuses a lower odometer before sending anything and focuses the field', async () => {
    const api = createMockApi();
    const update = vi.spyOn(api.vehicles, 'update');
    await edit(api);
    await screen.findByDisplayValue('ECO-001');
    type('Marca', 'Otra');
    type('Odómetro actual', '100');
    click('Guardar cambios');
    expect(
      screen.getByText('El odómetro no puede bajar: la lectura actual es 15,150 km.'),
    ).toBeInTheDocument();
    expect(getField('Odómetro actual')).toHaveFocus();
    expect(update).not.toHaveBeenCalled();
  });

  it('tells the person someone else changed the vehicle, and "Cargar datos actuales" starts over from the server', async () => {
    const api = createMockApi();
    await edit(api);
    await screen.findByDisplayValue('ECO-001');
    api.controls.changeVehicleExternally('veh-001', { odometerKm: 90000, make: 'Ajena' });
    type('Modelo', 'Mi cambio');
    click('Guardar cambios');
    expect(
      await screen.findByRole('heading', { name: 'Otra persona modificó este vehículo' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Tus cambios no se guardaron/)).toBeInTheDocument();
    expect(api.controls.vehicles()[0]?.model).toBe('NP300');
    click('Cargar datos actuales');
    await waitFor(() => expect(getField('Odómetro actual')).toHaveValue('90000'));
    expect(getField('Marca')).toHaveValue('Ajena');
    expect(getField('Modelo')).toHaveValue('NP300');
    expect(
      screen.queryByRole('heading', { name: 'Otra persona modificó este vehículo' }),
    ).toBeNull();
    type('Modelo', 'Mi cambio');
    click('Guardar cambios');
    await screen.findByText('Cambios guardados.');
  });

  it('keeps the saved changes and flags the odometer when the server rejects the reading afterwards (422)', async () => {
    const api = createMockApi();
    const update = vi.spyOn(api.vehicles, 'update');
    const odometer = vi.fn(async (): Promise<Result<Vehicle>> => error(422, 'odometer_decrease'));
    api.vehicles.recordOdometer = odometer;
    await edit(api);
    await screen.findByDisplayValue('ECO-001');
    type('Marca', 'Toyota');
    type('Odómetro actual', '16000');
    click('Guardar cambios');
    expect(
      await screen.findByRole('heading', { name: 'Lectura de odómetro rechazada' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Los demás datos del vehículo sí se guardaron/)).toBeInTheDocument();
    expect(
      screen.getByText('El odómetro no puede ser menor a la lectura que ya está registrada.'),
    ).toBeInTheDocument();
    await waitFor(() => expect(getField('Odómetro actual')).toHaveFocus());
    expect(api.controls.vehicles()[0]?.make).toBe('Toyota');
    // Retrying sends only the odometer, against the version the saved changes produced.
    odometer.mockImplementationOnce(async () => error(422, 'odometer_decrease'));
    click('Guardar cambios');
    await waitFor(() => expect(odometer).toHaveBeenCalledTimes(2));
    expect(update).toHaveBeenCalledTimes(1);
    expect(odometer).toHaveBeenLastCalledWith('veh-001', { version: 2, odometerKm: 16000 });
  });

  it('explains a vehicle archived by someone else while editing (409 immutable)', async () => {
    const api = createMockApi();
    await edit(api);
    await screen.findByDisplayValue('ECO-001');
    api.controls.archiveVehicleExternally('veh-001');
    type('Marca', 'Otra');
    click('Guardar cambios');
    expect(
      await screen.findByRole('heading', { name: 'El vehículo ya no admite cambios' }),
    ).toBeInTheDocument();
  });

  it('shows read-only vehicles as such instead of a form', async () => {
    const seed = [
      makeVehicle({
        id: 'a',
        economicNumber: 'ECO-A',
        plate: 'AAA-1',
        archivedAt: '2026-09-30T10:00:00.000Z',
      }),
      makeVehicle({ id: 'd', economicNumber: 'ECO-D', plate: 'DDD-1', status: 'decommissioned' }),
    ];
    const archived = await edit(createMockApi({ vehicles: seed }), 'a');
    expect(
      await screen.findByRole('heading', { name: 'Este vehículo no se puede editar' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Volver al vehículo' })).toHaveAttribute(
      'href',
      '/flota/vehiculos/a',
    );
    expect(screen.queryByRole('form')).toBeNull();
    archived.unmount();
    await edit(createMockApi({ vehicles: seed }), 'd');
    expect(
      await screen.findByRole('heading', { name: 'Este vehículo no se puede editar' }),
    ).toBeInTheDocument();
  });

  it('answers not found uniformly, retries a failed load and is closed to roles without edit', async () => {
    const missing = await edit(createMockApi(), 'no-existe');
    expect(
      await screen.findByRole('heading', { name: 'Vehículo no encontrado' }),
    ).toBeInTheDocument();
    missing.unmount();
    const flaky = createMockApi();
    flaky.controls.failNext('getVehicle');
    const failed = await edit(flaky);
    expect(
      await screen.findByRole('heading', { name: 'No pudimos cargar la información' }),
    ).toBeInTheDocument();
    click('Reintentar');
    await screen.findByDisplayValue('ECO-001');
    failed.unmount();
    const api = createMockApi();
    const get = vi.spyOn(api.vehicles, 'get');
    await edit(api, 'veh-001', 'viewer');
    expect(await screen.findByRole('heading', { name: 'No tienes acceso' })).toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
  });

  it('is open to a role with edit but not archive permission', async () => {
    await edit(createMockApi(), 'veh-001', 'dispatch');
    expect(await screen.findByDisplayValue('ECO-001')).toBeInTheDocument();
  });

  it('keeps unsaved edits through an expired session when the vehicle did not change meanwhile', async () => {
    const { api } = await edit();
    await screen.findByDisplayValue('ECO-001');
    type('Marca', 'Toyota');
    api.controls.expireSession();
    click('Guardar cambios');
    await screen.findByRole('group', { name: 'Sesión expirada' });
    type('Cuenta de prueba', demoSubjects.admin);
    click('Continuar');
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: 'Sesión expirada' })).toBeNull(),
    );
    await waitFor(() => expect(getField('Marca')).toHaveValue('Toyota'));
    expect(screen.queryByText(/El vehículo cambió desde que empezaste/)).toBeNull();
    click('Guardar cambios');
    await screen.findByText('Cambios guardados.');
    expect(api.controls.vehicles()[0]?.make).toBe('Toyota');
  });

  it('restores the edits after the odometer command expires the session once the field changes were saved', async () => {
    const api = createMockApi();
    const odometer = vi.fn(async (): Promise<Result<Vehicle>> => error(401, 'unauthorized'));
    api.vehicles.recordOdometer = odometer;
    await edit(api);
    await screen.findByDisplayValue('ECO-001');
    type('Marca', 'Toyota');
    type('Odómetro actual', '16000');
    click('Guardar cambios');
    await screen.findByRole('group', { name: 'Sesión expirada' });
    // The field changes were saved (version 2); the draft must follow that version.
    expect(api.controls.vehicles()[0]?.make).toBe('Toyota');
    type('Cuenta de prueba', demoSubjects.admin);
    click('Continuar');
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: 'Sesión expirada' })).toBeNull(),
    );
    await waitFor(() => expect(getField('Odómetro actual')).toHaveValue('16000'));
    expect(getField('Marca')).toHaveValue('Toyota');
    expect(screen.queryByText(/El vehículo cambió desde que empezaste/)).toBeNull();
  });

  it('does not restore edits over a newer version of the vehicle: it loads the current data and says so', async () => {
    const { api } = await edit(createMockApi({ vehicles: demoVehicles(2) }));
    await screen.findByDisplayValue('ECO-001');
    type('Marca', 'Toyota');
    api.controls.expireSession();
    click('Guardar cambios');
    await screen.findByRole('group', { name: 'Sesión expirada' });
    api.controls.changeVehicleExternally('veh-001', { make: 'Ajena' });
    type('Cuenta de prueba', demoSubjects.admin);
    click('Continuar');
    expect(
      await screen.findByText(/El vehículo cambió desde que empezaste a editar/),
    ).toBeInTheDocument();
    expect(getField('Marca')).toHaveValue('Ajena');
  });
});

describe('describeFailure', () => {
  it('shows nothing for a 401 (the session panel takes over) and the right wording for every other failure', () => {
    expect(describeFailure(apiError(401, 'unauthorized'), false)).toEqual({
      alert: null,
      fields: {},
    });
    const of = (status: ApiError['status'], code: string, saved = false) =>
      describeFailure(apiError(status, code), saved);
    expect(of(409, 'stale_version', true).alert?.message).toMatch(
      /Los demás datos del vehículo sí se guardaron/,
    );
    expect(of(409, 'stale_version').alert).toMatchObject({ actionLabel: 'Cargar datos actuales' });
    expect(of(409, 'immutable').alert?.title).toBe('El vehículo ya no admite cambios');
    expect(of(409, 'duplicate').fields).toEqual({});
    expect(of(422, 'odometer_decrease', true).alert?.message).toMatch(/sí se guardaron/);
    expect(of(422, 'odometer_decrease').fields.odometerKm).toMatch(/no puede ser menor/);
    expect(of(400, 'bad_request').alert?.title).toBe('El servidor rechazó los datos');
    expect(of(403, 'forbidden').alert?.title).toBe('No tienes permiso');
    expect(of(404, 'not_found').alert?.title).toBe('El vehículo ya no existe');
    expect(of(500, 'internal_error', true).alert?.message).toMatch(/sí se guardaron/);
    expect(of(500, 'network_error').alert?.title).toBe('No pudimos guardar el vehículo');
  });
});
