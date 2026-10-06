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
import type { ApiError, InsurancePolicy, Result } from '../app/types';
import { makeVehicle } from '../vehicles/fixtures';
import { makePolicy } from './fixtures';
import { describeFailure } from './PolicyFormScreen';

const apiError = (status: ApiError['status'], code: string): ApiError => ({
  code,
  status,
  message: 'x',
  correlationId: 'c',
});
const fail = (status: ApiError['status'], code: string): Result<InsurancePolicy> => ({
  ok: false,
  error: apiError(status, code),
});
const choose = (label: string, value: string) =>
  fireEvent.change(getField(label), { target: { value } });

async function openCreate(options: Parameters<typeof renderApp>[0] = {}) {
  const view = await renderApp({ path: '/flota/seguros/nueva', ...options });
  await screen.findByRole('heading', { name: 'Nueva póliza', level: 1 });
  await screen.findByRole('option', { name: /ECO-001 · Nissan NP300/ });
  return view;
}

function fillCreate(overrides: Record<string, string> = {}) {
  const values: Record<string, string> = {
    'Vehículo asegurado': 'veh-001',
    Aseguradora: 'Seguros Demo',
    'Número de póliza': 'pol-77',
    'Tipo de cobertura': 'comprehensive',
    'Inicio de vigencia': '2026-11-01',
    'Fin de vigencia': '2027-10-31',
    ...overrides,
  };
  for (const [label, value] of Object.entries(values))
    if (['Vehículo asegurado', 'Tipo de cobertura', 'Tipo de deducible'].includes(label))
      choose(label, value);
    else type(label, value);
}

describe('create policy', () => {
  it('explains every missing field, focuses the first one and does not call the API', async () => {
    const api = createMockApi();
    const create = vi.spyOn(api.insurance, 'create');
    await openCreate({ api });
    click('Crear póliza');
    for (const message of [
      'Elige el vehículo de la póliza.',
      'Escribe el nombre de la aseguradora.',
      'Escribe el número de póliza.',
      'Elige el tipo de cobertura.',
      'Elige el primer día de cobertura.',
      'Elige el último día de cobertura.',
    ])
      expect(screen.getByText(message)).toBeInTheDocument();
    expect(getField('Vehículo asegurado')).toHaveFocus();
    expect(getField('Vehículo asegurado')).toHaveAttribute('aria-invalid', 'true');
    expect(create).not.toHaveBeenCalled();
    choose('Vehículo asegurado', 'veh-001');
    expect(screen.queryByText('Elige el vehículo de la póliza.')).toBeNull();
  });

  it('creates the policy with normalized values and opens its detail with a confirmation', async () => {
    const api = createMockApi();
    const create = vi.spyOn(api.insurance, 'create');
    await openCreate({ api });
    fillCreate({ 'Notas de cobertura': ' Incluye cristales ' });
    click('Crear póliza');
    expect(
      await screen.findByRole('heading', { name: 'Póliza POL-77', level: 1 }),
    ).toBeInTheDocument();
    // No deductible chosen: the key is not sent at all.
    expect(create).toHaveBeenCalledWith({
      vehicleId: 'veh-001',
      insurer: 'Seguros Demo',
      coverageNotes: 'Incluye cristales',
      policyNumber: 'POL-77',
      coverageType: 'comprehensive',
      startsOn: '2026-11-01',
      endsOn: '2027-10-31',
    });
    expect(screen.getByText('Póliza creada.')).toBeInTheDocument();
    await waitFor(() => expect(window.location.search).toBe(''));
    expect(window.location.pathname).toMatch(/^\/flota\/seguros\/pol-nueva-/);
    expect(api.controls.policies()).toHaveLength(29);
  });

  it('sends an exact amount in minor units when the role can see costs, and shows it on the detail', async () => {
    const api = createMockApi();
    const create = vi.spyOn(api.insurance, 'create');
    await openCreate({ api });
    expect(screen.getByRole('group', { name: 'Deducible' })).toBeInTheDocument();
    fillCreate({ 'Tipo de deducible': 'amount' });
    type('Monto del deducible', '12500.5');
    click('Crear póliza');
    await screen.findByRole('heading', { name: 'Póliza POL-77', level: 1 });
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      deductible: { kind: 'amount', amountMinor: 1_250_050, currency: 'MXN' },
    });
    expect(await screen.findByText('12,500.50 MXN', { selector: 'dd' })).toBeInTheDocument();
  });

  it('sends a percentage in basis points', async () => {
    const api = createMockApi();
    const create = vi.spyOn(api.insurance, 'create');
    await openCreate({ api });
    fillCreate({ 'Tipo de deducible': 'percent' });
    type('Porcentaje del deducible', '12.5');
    click('Crear póliza');
    await screen.findByRole('heading', { name: 'Póliza POL-77', level: 1 });
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      deductible: { kind: 'percent', basisPoints: 1250 },
    });
  });

  it('validates the deductible fields and shows only the ones of the chosen kind', async () => {
    const api = createMockApi();
    const create = vi.spyOn(api.insurance, 'create');
    await openCreate({ api });
    fillCreate();
    expect(screen.queryByLabelText(/Monto del deducible/)).toBeNull();
    choose('Tipo de deducible', 'amount');
    expect(screen.queryByLabelText(/Porcentaje del deducible/)).toBeNull();
    click('Crear póliza');
    expect(screen.getByText('Escribe el monto del deducible.')).toBeInTheDocument();
    expect(getField('Monto del deducible')).toHaveFocus();
    type('Monto del deducible', '12.345');
    type('Moneda', 'pesos');
    click('Crear póliza');
    expect(screen.getByText(/código de moneda de 3 letras/)).toBeInTheDocument();
    type('Moneda', 'mxn');
    click('Crear póliza');
    expect(screen.getByText(/hasta 2 decimales/)).toBeInTheDocument();
    choose('Tipo de deducible', 'percent');
    click('Crear póliza');
    expect(screen.getByText(/entre 0.01 y 100/)).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
  });

  it('does not offer the deductible without view_costs, says why, and never sends the key', async () => {
    const api = createMockApi();
    const create = vi.spyOn(api.insurance, 'create');
    await openCreate({ api, account: 'dispatch' });
    expect(screen.queryByRole('group', { name: 'Deducible' })).toBeNull();
    expect(screen.queryByLabelText(/Tipo de deducible/)).toBeNull();
    expect(screen.getByText(/registrarlo requiere permiso para ver costos/)).toBeInTheDocument();
    fillCreate();
    click('Crear póliza');
    await screen.findByRole('heading', { name: 'Póliza POL-77', level: 1 });
    expect(Object.hasOwn(create.mock.calls[0]?.[0] ?? {}, 'deductible')).toBe(false);
  });

  it('puts an unavailable vehicle (422 invalid_vehicle) next to its field and focuses it', async () => {
    const api = createMockApi();
    await openCreate({ api });
    fillCreate();
    await api.vehicles.archive('veh-001', 1);
    click('Crear póliza');
    expect(
      await screen.findByText('El vehículo no existe o está archivado. Elige otro de la lista.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'El vehículo no es válido' })).toBeInTheDocument();
    await waitFor(() => expect(getField('Vehículo asegurado')).toHaveFocus());
  });

  it('blocks a second submit while saving', async () => {
    const api = createMockApi();
    const real = api.insurance.create;
    const gate = deferred();
    let calls = 0;
    api.insurance.create = async (input) => {
      calls += 1;
      await gate.promise;
      return real(input);
    };
    await openCreate({ api });
    fillCreate();
    click('Crear póliza');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cargando…' })).toBeDisabled());
    fireEvent.submit(screen.getByRole('form', { name: 'Nueva póliza' }));
    expect(calls).toBe(1);
    await act(async () => gate.resolve());
    await screen.findByText('Póliza creada.');
  });

  it.each([
    [400, 'bad_request', 'El servidor rechazó los datos'],
    [403, 'forbidden', 'No tienes permiso'],
    [500, 'internal_error', 'No pudimos guardar la póliza'],
  ] as const)('shows a %s failure without losing the form', async (status, code, title) => {
    const api = createMockApi();
    api.insurance.create = async () => fail(status, code);
    await openCreate({ api });
    fillCreate();
    click('Crear póliza');
    expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument();
    expect(getField('Número de póliza')).toHaveValue('pol-77');
  });

  it('keeps what was typed when the session expires, and saves after signing in again', async () => {
    const { api } = await openCreate();
    fillCreate();
    api.controls.expireSession();
    click('Crear póliza');
    await screen.findByRole('group', { name: 'Sesión expirada' });
    expect(getField('Número de póliza')).toHaveValue('pol-77');
    type('Cuenta de prueba', demoSubjects.admin);
    click('Continuar');
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: 'Sesión expirada' })).toBeNull(),
    );
    click('Crear póliza');
    await screen.findByText('Póliza creada.');
  });

  it('offers a retry when the vehicles cannot be loaded, and invites to register one when there are none', async () => {
    const api = createMockApi();
    api.controls.failNext('listVehicles');
    const failed = await renderApp({ api, path: '/flota/seguros/nueva' });
    expect(
      await screen.findByRole('heading', { name: 'No pudimos cargar la información' }),
    ).toBeInTheDocument();
    click('Reintentar');
    await screen.findByRole('option', { name: /ECO-001/ });
    failed.unmount();
    await renderApp({ api: createMockApi({ vehicles: [] }), path: '/flota/seguros/nueva' });
    expect(
      await screen.findByRole('heading', { name: 'Aún no hay vehículos' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Registrar un vehículo nuevo' })).toHaveAttribute(
      'href',
      '/flota/vehiculos/nuevo',
    );
  });

  it('says when only part of the fleet is offered, cancels back to the list and is closed to a role without create', async () => {
    const vehicles = Array.from({ length: 501 }, (_, index) =>
      makeVehicle({
        id: `v${index}`,
        economicNumber: `E-${String(index).padStart(4, '0')}`,
        plate: `P-${index}`,
      }),
    );
    const big = await renderApp({
      api: createMockApi({ vehicles }),
      path: '/flota/seguros/nueva',
    });
    expect(
      await screen.findByText('Se muestran los primeros vehículos del listado.'),
    ).toBeInTheDocument();
    big.unmount();
    const view = await openCreate();
    fireEvent.click(screen.getByRole('link', { name: 'Cancelar' }));
    await screen.findByRole('heading', { name: 'Seguros', level: 1 });
    expect(window.location.pathname).toBe('/flota/seguros');
    view.unmount();
    await renderApp({ account: 'mechanic', path: '/flota/seguros/nueva' });
    expect(await screen.findByRole('heading', { name: 'No tienes acceso' })).toBeInTheDocument();
  });
});

describe('edit policy', () => {
  const edit = (
    api = createMockApi(),
    id = 'pol-001',
    account: 'admin' | 'viewer' | 'dispatch' = 'admin',
  ) => renderApp({ api, account, path: `/flota/seguros/${id}/editar` });

  it('opens with the insurer and notes, shows what cannot change and explains how to change the rest', async () => {
    await edit();
    await screen.findByDisplayValue('Aseguradora Demo Norte');
    expect(screen.getByRole('heading', { name: 'Editar póliza', level: 1 })).toBeInTheDocument();
    expect(screen.getByText(/renueva la póliza/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Inicio de vigencia/)).toBeNull();
    expect(screen.queryByLabelText(/Número de póliza/)).toBeNull();
    expect(screen.queryByRole('group', { name: 'Deducible' })).toBeNull();
    const form = screen.getByRole('form', { name: 'Editar póliza' });
    expect(form).toHaveTextContent('POL-2026-0001');
    expect(form).toHaveTextContent('Responsabilidad civil obligatoria');
    await waitFor(() => expect(form).toHaveTextContent('ECO-001'));
  });

  it('does not call the API when nothing changed, and validates the insurer', async () => {
    const api = createMockApi();
    const update = vi.spyOn(api.insurance, 'update');
    await edit(api);
    await screen.findByDisplayValue('Aseguradora Demo Norte');
    click('Guardar cambios');
    expect(await screen.findByText('No hay cambios que guardar.')).toBeInTheDocument();
    type('Aseguradora', ' ');
    click('Guardar cambios');
    expect(screen.getByText('Escribe el nombre de la aseguradora.')).toBeInTheDocument();
    expect(getField('Aseguradora')).toHaveFocus();
    expect(update).not.toHaveBeenCalled();
  });

  it('sends only the changed fields with the version it loaded and shows the result on the detail', async () => {
    const api = createMockApi();
    const update = vi.spyOn(api.insurance, 'update');
    await edit(api);
    await screen.findByDisplayValue('Aseguradora Demo Norte');
    type('Aseguradora', '  Otra   aseguradora ');
    type('Notas de cobertura', 'Con asistencia');
    click('Guardar cambios');
    expect(await screen.findByText('Cambios guardados.')).toBeInTheDocument();
    expect(update).toHaveBeenCalledWith('pol-001', {
      version: 1,
      insurer: 'Otra aseguradora',
      coverageNotes: 'Con asistencia',
    });
    expect(window.location.pathname).toBe('/flota/seguros/pol-001');
  });

  it('tells the person someone else changed the policy, and "Cargar datos actuales" starts over from the server', async () => {
    const { api } = await edit();
    await screen.findByDisplayValue('Aseguradora Demo Norte');
    api.controls.changePolicyExternally('pol-001', { insurer: 'Cambiada por otra persona' });
    type('Aseguradora', 'Mi aseguradora');
    click('Guardar cambios');
    expect(
      await screen.findByRole('heading', { name: 'Otra persona modificó esta póliza' }),
    ).toBeInTheDocument();
    click('Cargar datos actuales');
    await waitFor(() => expect(getField('Aseguradora')).toHaveValue('Cambiada por otra persona'));
  });

  it('explains a policy archived by someone else while editing, and shows archived policies as read-only', async () => {
    const { api, unmount } = await edit();
    await screen.findByDisplayValue('Aseguradora Demo Norte');
    api.controls.archivePolicyExternally('pol-001');
    type('Aseguradora', 'Otra aseguradora');
    click('Guardar cambios');
    expect(
      await screen.findByRole('heading', { name: 'La póliza ya no admite cambios' }),
    ).toBeInTheDocument();
    unmount();
    await edit(
      createMockApi({ policies: [makePolicy({ archivedAt: '2026-09-30T10:00:00.000Z' })] }),
    );
    expect(
      await screen.findByRole('heading', { name: 'Esta póliza no se puede cambiar' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Volver a la póliza' })).toHaveAttribute(
      'href',
      '/flota/seguros/pol-001',
    );
  });

  it('answers not found uniformly, retries a failed load and is closed to a viewer', async () => {
    const missing = await edit(createMockApi(), 'no-existe');
    expect(
      await screen.findByRole('heading', { name: 'Póliza no encontrada' }),
    ).toBeInTheDocument();
    missing.unmount();
    const flaky = createMockApi();
    flaky.controls.failNext('getPolicy');
    const failed = await edit(flaky);
    expect(
      await screen.findByRole('heading', { name: 'No pudimos cargar la información' }),
    ).toBeInTheDocument();
    click('Reintentar');
    await screen.findByDisplayValue('Aseguradora Demo Norte');
    failed.unmount();
    await edit(createMockApi(), 'pol-001', 'viewer');
    expect(await screen.findByRole('heading', { name: 'No tienes acceso' })).toBeInTheDocument();
  });

  it('keeps unsaved edits through an expired session, unless the policy changed meanwhile', async () => {
    const { api } = await edit();
    await screen.findByDisplayValue('Aseguradora Demo Norte');
    type('Aseguradora', 'Pendiente S.A.');
    api.controls.expireSession();
    click('Guardar cambios');
    await screen.findByRole('group', { name: 'Sesión expirada' });
    type('Cuenta de prueba', demoSubjects.admin);
    click('Continuar');
    await waitFor(() => expect(getField('Aseguradora')).toHaveValue('Pendiente S.A.'));
    expect(screen.queryByText(/La póliza cambió desde que empezaste/)).toBeNull();
    api.controls.expireSession();
    click('Guardar cambios');
    await screen.findByRole('group', { name: 'Sesión expirada' });
    api.controls.changePolicyExternally('pol-001', { insurer: 'Ajena S.A.' });
    type('Cuenta de prueba', demoSubjects.admin);
    click('Continuar');
    expect(await screen.findByText(/La póliza cambió desde que empezaste/)).toBeInTheDocument();
    expect(getField('Aseguradora')).toHaveValue('Ajena S.A.');
  });
});

describe('renew policy', () => {
  const renew = (
    api = createMockApi(),
    id = 'pol-002',
    account: 'admin' | 'viewer' | 'dispatch' = 'admin',
  ) => renderApp({ api, account, path: `/flota/seguros/${id}/renovar` });

  it('opens with the number, coverage and deductible carried over and the following year proposed', async () => {
    await renew();
    await screen.findByRole('heading', { name: 'Renovar póliza', level: 1 });
    expect(await screen.findByDisplayValue('POL-2026-0002')).toBeInTheDocument();
    expect(getField('Tipo de cobertura')).toHaveValue('third_party');
    expect(getField('Inicio de vigencia')).toHaveValue('2026-10-04');
    expect(getField('Fin de vigencia')).toHaveValue('2027-10-03');
    expect(getField('Tipo de deducible')).toHaveValue('amount');
    expect(getField('Monto del deducible')).toHaveValue('12500.00');
    expect(
      screen.getByText(/La anterior queda en el historial como reemplazada/),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/Aseguradora/)).toBeNull();
  });

  it('renews with the new period, sends the deductible explicitly and shows the replaced revision', async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api.insurance, 'renew');
    await renew(api);
    await screen.findByDisplayValue('POL-2026-0002');
    type('Fin de vigencia', '2027-12-31');
    choose('Tipo de deducible', 'none');
    click('Renovar póliza');
    expect(
      await screen.findByText('Póliza renovada. La revisión anterior quedó en el historial.'),
    ).toBeInTheDocument();
    expect(spy).toHaveBeenCalledWith('pol-002', {
      version: 1,
      policyNumber: 'POL-2026-0002',
      coverageType: 'third_party',
      startsOn: '2026-10-04',
      endsOn: '2027-12-31',
      deductible: null,
    });
    expect(await screen.findByText('Revisión 3 · Vigente')).toBeInTheDocument();
    expect(screen.getAllByText(/Revisión [12] · Reemplazada/)).toHaveLength(2);
  });

  it('keeps the current deductible without sending it when the role cannot see costs', async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api.insurance, 'renew');
    await renew(api, 'pol-002', 'dispatch');
    await screen.findByDisplayValue('POL-2026-0002');
    expect(screen.queryByLabelText(/Tipo de deducible/)).toBeNull();
    expect(screen.getByText(/El deducible actual se conserva/)).toBeInTheDocument();
    click('Renovar póliza');
    await screen.findByText(/Póliza renovada/);
    expect(Object.hasOwn(spy.mock.calls[0]?.[1] ?? {}, 'deductible')).toBe(false);
    expect(api.controls.policies()[1]?.deductible).toEqual({
      kind: 'amount',
      amountMinor: 1_250_000,
      currency: 'MXN',
    });
  });

  it('refuses an end before the start without calling the API', async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api.insurance, 'renew');
    await renew(api);
    await screen.findByDisplayValue('POL-2026-0002');
    type('Fin de vigencia', '2026-01-01');
    click('Renovar póliza');
    expect(
      screen.getByText('El fin de la vigencia no puede ser anterior al inicio.'),
    ).toBeInTheDocument();
    expect(getField('Fin de vigencia')).toHaveFocus();
    expect(spy).not.toHaveBeenCalled();
  });

  it('tells the person someone else changed the policy, and archived policies cannot be renewed', async () => {
    const { api } = await renew();
    await screen.findByDisplayValue('POL-2026-0002');
    api.controls.changePolicyExternally('pol-002', { insurer: 'Otra aseguradora' });
    click('Renovar póliza');
    expect(
      await screen.findByRole('heading', { name: 'Otra persona modificó esta póliza' }),
    ).toBeInTheDocument();
    click('Cargar datos actuales');
    await waitFor(() =>
      expect(
        screen.queryByRole('heading', { name: 'Otra persona modificó esta póliza' }),
      ).toBeNull(),
    );
    api.controls.archivePolicyExternally('pol-002');
    click('Renovar póliza');
    expect(
      await screen.findByRole('heading', { name: 'La póliza ya no admite cambios' }),
    ).toBeInTheDocument();
  });

  it('explains a vehicle that was archived since (422 invalid_vehicle) and is closed to a viewer', async () => {
    const { api, unmount } = await renew();
    await screen.findByDisplayValue('POL-2026-0002');
    await api.vehicles.archive('veh-003', 1);
    click('Renovar póliza');
    expect(
      await screen.findByText(/ya no existe o está archivado, por lo que no se puede renovar/),
    ).toBeInTheDocument();
    unmount();
    await renew(createMockApi(), 'pol-002', 'viewer');
    expect(await screen.findByRole('heading', { name: 'No tienes acceso' })).toBeInTheDocument();
  });
});

describe('describeFailure', () => {
  it('shows nothing for a 401 (the session panel takes over) and the right wording for every other failure', () => {
    expect(describeFailure(apiError(401, 'unauthorized'), 'edit')).toEqual({
      alert: null,
      fields: {},
    });
    const of = (
      status: ApiError['status'],
      code: string,
      mode: 'create' | 'edit' | 'renew' = 'edit',
    ) => describeFailure(apiError(status, code), mode);
    expect(of(409, 'stale_version').alert).toMatchObject({ actionLabel: 'Cargar datos actuales' });
    expect(of(409, 'immutable').alert?.title).toBe('La póliza ya no admite cambios');
    expect(of(422, 'invalid_vehicle', 'create').alert?.message).toMatch(/Elige otro vehículo/);
    expect(of(422, 'invalid_vehicle', 'renew').alert?.message).toMatch(/no se puede renovar/);
    expect(of(422, 'invalid_vehicle', 'renew').fields).toEqual({});
    expect(of(400, 'bad_request').alert?.title).toBe('El servidor rechazó los datos');
    expect(of(403, 'forbidden', 'renew').alert?.message).toMatch(/renovar esta póliza/);
    expect(of(403, 'forbidden').alert?.message).toMatch(/Escribir el deducible requiere/);
    expect(of(404, 'not_found').alert?.title).toBe('La póliza ya no existe');
    expect(of(500, 'network_error', 'renew').alert?.title).toBe('No pudimos renovar la póliza');
  });
});
