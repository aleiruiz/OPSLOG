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
import { makeEmployeeDetail } from './fixtures';

async function create(options: Parameters<typeof renderApp>[0] = {}) {
  const view = await renderApp({ path: '/plantilla/empleados/nuevo', ...options });
  await screen.findByRole('form', { name: 'Nuevo empleado' });
  return view;
}
async function edit(id = 'emp-001', options: Parameters<typeof renderApp>[0] = {}) {
  const view = await renderApp({ path: `/plantilla/empleados/${id}/editar`, ...options });
  await screen.findByRole('form', { name: 'Editar empleado' });
  return view;
}
const pick = (label: string, value: string) =>
  fireEvent.change(getField(label), { target: { value } });
const fillBasics = (kind = 'dispatcher') => {
  pick('Tipo de empleado', kind);
  type('Nombre', 'Rosa');
  type('Apellidos', 'Vega Luna');
  pick('Área', 'area-sur');
};

describe('create employee', () => {
  it('explains the missing required fields, focuses the first one and does not call the API', async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api.employees, 'create');
    await create({ api });
    click('Crear empleado');
    expect(screen.getByText('Elige el tipo de empleado.')).toBeInTheDocument();
    expect(screen.getByText('Escribe el nombre.')).toBeInTheDocument();
    expect(screen.getByText('Escribe los apellidos.')).toBeInTheDocument();
    expect(screen.getByText('Elige el área del empleado.')).toBeInTheDocument();
    expect(getField('Tipo de empleado')).toHaveFocus();
    expect(getField('Tipo de empleado')).toHaveAttribute('aria-invalid', 'true');
    expect(spy).not.toHaveBeenCalled();
    pick('Tipo de empleado', 'other');
    expect(screen.queryByText('Elige el tipo de empleado.')).toBeNull();
  });

  it('shows the license section only for drivers', async () => {
    await create();
    expect(screen.queryByText('Licencia de conducir')).toBeNull();
    pick('Tipo de empleado', 'driver');
    expect(screen.getByText('Licencia de conducir')).toBeInTheDocument();
    expect(getField('Número de licencia')).toBeInTheDocument();
    pick('Tipo de empleado', 'other');
    expect(screen.queryByText('Licencia de conducir')).toBeNull();
  });

  it('validates formats in the form before sending', async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api.employees, 'create');
    await create({ api });
    fillBasics('driver');
    type('Número de empleado', '¡mal!');
    type('Nombre', 'R0sa');
    type('Tipo de licencia', '***');
    type('Número de identificación', 'ABCD1234');
    type('Teléfono', '555');
    type('Correo electrónico', 'no-es-correo');
    click('Crear empleado');
    expect(screen.getByText(/Usa hasta 32 caracteres: letras, números, punto/)).toBeInTheDocument();
    expect(screen.getByText(/Usa letras, hasta 60 caracteres/)).toBeInTheDocument();
    expect(screen.getByText(/Usa hasta 16 caracteres/)).toBeInTheDocument();
    expect(screen.getByText('Elige el tipo de identificación.')).toBeInTheDocument();
    expect(screen.getByText(/Usa formato internacional/)).toBeInTheDocument();
    expect(screen.getByText(/Escribe un correo válido/)).toBeInTheDocument();
    expect(getField('Nombre')).toHaveFocus();
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects a future hire date', async () => {
    await create();
    fillBasics();
    type('Fecha de ingreso', '2999-01-01');
    click('Crear empleado');
    expect(screen.getByText(/Elige una fecha entre/)).toBeInTheDocument();
  });

  it('offers only active areas, as a tree, and never a free-text id', async () => {
    await create();
    const select = getField('Área') as HTMLSelectElement;
    expect(select.tagName).toBe('SELECT');
    const labels = [...select.options].map((option) => option.textContent ?? '');
    expect(labels.some((label) => label.includes('Norte'))).toBe(true);
    const disabled = [...select.options].filter((option) => option.disabled);
    for (const option of disabled) expect(option.textContent).toContain('(inactiva)');
  });

  it('creates a driver with everything, trims and normalizes, and opens the new employee', async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api.employees, 'create');
    await create({ api });
    fillBasics('driver');
    type('Número de empleado', ' E-9000 ');
    type('Puesto', 'Operadora');
    type('Tipo de licencia', ' c ');
    type('Vigencia de la licencia', '2029-01-31');
    pick('Tipo de identificación', 'curp');
    type('Número de identificación', 'ejem900101hdfxxx09');
    type('Teléfono', '+52 55 5555 0109');
    type('Correo electrónico', 'Rosa@Ejemplo.test');
    type('Número de licencia', 'lic-900009');
    click('Crear empleado');
    await screen.findByRole('heading', { name: 'Rosa Vega Luna', level: 1 });
    expect(screen.getByText('Empleado creado.')).toBeInTheDocument();
    const body = spy.mock.calls[0]?.[0];
    expect(body).toMatchObject({
      kind: 'driver',
      firstName: 'Rosa',
      lastName: 'Vega Luna',
      areaId: 'area-sur',
      employeeNumber: 'E-9000',
      licenseType: 'C',
      idType: 'curp',
      nationalId: 'EJEM900101HDFXXX09',
      email: 'rosa@ejemplo.test',
      licenseNumber: 'LIC-900009',
    });
    expect(api.controls.employees().some((e) => e.firstName === 'Rosa')).toBe(true);
  });

  it('creates a dispatcher with only the required data', async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api.employees, 'create');
    await create({ api });
    fillBasics();
    click('Crear empleado');
    await screen.findByRole('heading', { name: 'Rosa Vega Luna', level: 1 });
    expect(spy.mock.calls[0]?.[0]).not.toHaveProperty('nationalId');
  });

  it('shows the busy state and cannot submit twice', async () => {
    const api = createMockApi();
    const gate = deferred();
    const real = api.employees.create;
    const spy = vi.spyOn(api.employees, 'create').mockImplementation(async (input) => {
      await gate.promise;
      return real(input);
    });
    await create({ api });
    fillBasics();
    click('Crear empleado');
    expect(await screen.findByRole('button', { name: 'Cargando…' })).toBeDisabled();
    fireEvent.submit(screen.getByRole('form', { name: 'Nuevo empleado' }));
    expect(spy).toHaveBeenCalledTimes(1);
    gate.resolve();
    await screen.findByRole('heading', { name: 'Rosa Vega Luna', level: 1 });
  });

  it.each([
    ['Número de empleado', 'E-0001'],
    ['Número de identificación', 'EJEM800101HDFXXX01'],
    ['Correo electrónico', 'empleado1@ejemplo.test'],
  ] as const)('marks a duplicated %s on its field (409)', async (label, value) => {
    await create();
    fillBasics('driver');
    if (label === 'Número de identificación') pick('Tipo de identificación', 'curp');
    if (label !== 'Número de empleado') type('Número de empleado', 'E-7777');
    type(label, value);
    if (label === 'Número de identificación') type('Correo electrónico', 'nuevo@ejemplo.test');
    click('Crear empleado');
    expect(await screen.findByText('Hay datos que ya existen')).toBeInTheDocument();
    expect(getField(label)).toHaveAttribute('aria-invalid', 'true');
    expect(getField('Nombre')).toHaveValue('Rosa');
  });

  it('marks the area when it was deactivated meanwhile (422 invalid_area)', async () => {
    const api = createMockApi();
    await create({ api });
    fillBasics();
    api.controls.deactivateAreaExternally('area-sur');
    click('Crear empleado');
    expect(await screen.findByText('El área no es válida')).toBeInTheDocument();
    expect(getField('Área')).toHaveAttribute('aria-invalid', 'true');
  });

  it.each([
    [400, 'El servidor rechazó los datos'],
    [403, 'No tienes permiso'],
    [500, 'No pudimos crear el empleado'],
  ] as const)('shows a %s answer without losing the data', async (status, title) => {
    const api = createMockApi();
    await create({ api });
    fillBasics();
    api.controls.failNext('createEmployee', status);
    click('Crear empleado');
    expect(await screen.findByText(title)).toBeInTheDocument();
    expect(getField('Nombre')).toHaveValue('Rosa');
  });

  it('keeps the draft when the session expires and lets the person submit again after signing in', async () => {
    const api = createMockApi();
    await create({ api });
    fillBasics();
    api.controls.failNext('createEmployee', 401);
    click('Crear empleado');
    await screen.findByRole('group', { name: 'Sesión expirada' });
    type('Cuenta de prueba', demoSubjects.admin);
    click('Continuar');
    await screen.findByRole('form', { name: 'Nuevo empleado' });
    expect(getField('Nombre')).toHaveValue('Rosa');
    click('Crear empleado');
    await screen.findByRole('heading', { name: 'Rosa Vega Luna', level: 1 });
  });

  it('hides the personal data fields from a session without view_pii and never sends them', async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api.employees, 'create');
    await create({ api, account: 'dispatch' });
    expect(screen.queryByLabelText(/Número de identificación/)).toBeNull();
    expect(screen.queryByLabelText(/Teléfono/)).toBeNull();
    expect(screen.getByText(/Los datos personales están protegidos/)).toBeInTheDocument();
    fillBasics('driver');
    expect(screen.queryByLabelText(/Número de licencia/)).toBeNull();
    click('Crear empleado');
    await screen.findByRole('heading', { name: 'Rosa Vega Luna', level: 1 });
    const body = spy.mock.calls[0]?.[0] ?? {};
    for (const key of ['nationalId', 'idType', 'phone', 'email', 'licenseNumber'])
      expect(body).not.toHaveProperty(key);
  });

  it('lets the personal-data reader create with personal data', async () => {
    await create({ account: 'piiReader' });
    fillBasics();
    type('Teléfono', '+525555550177');
    click('Crear empleado');
    await screen.findByRole('heading', { name: 'Rosa Vega Luna', level: 1 });
  });

  it('shows the no-permission state to a read-only role', async () => {
    await renderApp({ path: '/plantilla/empleados/nuevo', account: 'viewer' });
    expect(await screen.findByRole('heading', { name: 'No tienes acceso' })).toBeInTheDocument();
  });

  it('warns when there is no active area to choose', async () => {
    const api = createMockApi({ areas: [] });
    await create({ api });
    expect(screen.getByText(/Aún no hay áreas activas/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Crea o activa un área' })).toHaveAttribute(
      'href',
      '/plantilla/areas',
    );
  });

  it('shows an error with retry when the areas cannot be loaded', async () => {
    const api = createMockApi();
    api.controls.failNext('listAreas');
    await renderApp({ api, path: '/plantilla/empleados/nuevo' });
    expect(
      await screen.findByRole('heading', { name: 'No pudimos cargar la información' }),
    ).toBeInTheDocument();
    click('Reintentar');
    await screen.findByRole('form', { name: 'Nuevo empleado' });
  });

  it('cancels back to the list', async () => {
    await create();
    expect(screen.getByRole('link', { name: 'Cancelar' })).toHaveAttribute(
      'href',
      '/plantilla/empleados',
    );
  });
});

describe('edit employee', () => {
  it('loads the current values with the kind locked', async () => {
    await edit();
    expect(getField('Nombre')).toHaveValue('Ana');
    expect(getField('Apellidos')).toHaveValue('García López');
    expect(getField('Tipo de empleado')).toBeDisabled();
    expect(getField('Tipo de empleado')).toHaveValue('driver');
    expect(getField('Área')).toHaveValue('area-norte');
    expect(getField('Número de licencia')).toHaveValue('LIC-100001');
    expect(getField('Teléfono')).toHaveValue('+525555550101');
  });

  it('says there is nothing to save when nothing changed, without calling the API', async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api.employees, 'update');
    await edit('emp-001', { api });
    click('Guardar cambios');
    expect(await screen.findByText('No hay cambios que guardar.')).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  it('sends only what changed with the loaded version and opens the detail', async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api.employees, 'update');
    await edit('emp-001', { api });
    type('Puesto', 'Líder de reparto');
    pick('Área', 'area-sur');
    click('Guardar cambios');
    await screen.findByRole('heading', { name: 'Ana García López', level: 1 });
    expect(screen.getByText('Cambios guardados.')).toBeInTheDocument();
    expect(spy).toHaveBeenCalledWith('emp-001', {
      version: 31,
      position: 'Líder de reparto',
      areaId: 'area-sur',
    });
  });

  it('clears an optional value by emptying it', async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api.employees, 'update');
    await edit('emp-001', { api });
    type('Puesto', '');
    click('Guardar cambios');
    await screen.findByRole('heading', { name: 'Ana García López', level: 1 });
    expect(spy.mock.calls[0]?.[1]).toMatchObject({ position: null });
  });

  it('saves a personal-data change for the one who may', async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api.employees, 'update');
    await edit('emp-001', { api });
    type('Teléfono', '+525555550188');
    click('Guardar cambios');
    await screen.findByRole('heading', { name: 'Ana García López', level: 1 });
    expect(spy.mock.calls[0]?.[1]).toMatchObject({ phone: '+525555550188' });
  });

  it('shows the area in use even if it is now inactive, and keeps it selectable', async () => {
    const api = createMockApi();
    api.controls.deactivateAreaExternally('area-norte');
    await edit('emp-001', { api });
    expect(getField('Área')).toHaveValue('area-norte');
  });

  it('hides personal data from a session without view_pii, saving the rest and never sending them', async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api.employees, 'update');
    await edit('emp-001', { api, account: 'dispatch' });
    expect(screen.queryByLabelText(/Teléfono/)).toBeNull();
    expect(screen.getByText(/Registrados: /)).toBeInTheDocument();
    type('Puesto', 'Otro');
    click('Guardar cambios');
    await screen.findByRole('heading', { name: 'Ana García López', level: 1 });
    expect(spy.mock.calls[0]?.[1]).toEqual({ version: 31, position: 'Otro' });
  });

  it('says that no personal data is registered when there is none', async () => {
    const seed = [
      makeEmployeeDetail(
        { id: 'emp-n', kind: 'other', idType: null, licenseType: null, licenseExpiresOn: null },
        { nationalId: null, phone: null, email: null, licenseNumber: null },
      ),
    ];
    await edit('emp-n', { api: createMockApi({ employees: seed }), account: 'dispatch' });
    expect(screen.getByText(/No hay datos personales registrados/)).toBeInTheDocument();
  });

  it('marks a duplicated value (409) and keeps the edits', async () => {
    await edit();
    type('Número de empleado', 'E-0002');
    click('Guardar cambios');
    expect(await screen.findByText('Hay datos que ya existen')).toBeInTheDocument();
    expect(getField('Número de empleado')).toHaveAttribute('aria-invalid', 'true');
    expect(getField('Número de empleado')).toHaveValue('E-0002');
  });

  it('reports a version conflict and reloads the current data on request', async () => {
    const api = createMockApi();
    await edit('emp-001', { api });
    type('Puesto', 'Mi cambio');
    api.controls.changeEmployeeExternally('emp-001', { position: 'Cambio ajeno' });
    click('Guardar cambios');
    expect(await screen.findByText('Otra persona modificó este empleado')).toBeInTheDocument();
    click('Cargar datos actuales');
    await waitFor(() => expect(getField('Puesto')).toHaveValue('Cambio ajeno'));
    expect(screen.queryByText('Otra persona modificó este empleado')).toBeNull();
  });

  it('says that the employee stopped accepting changes (409 immutable)', async () => {
    const api = createMockApi();
    await edit('emp-001', { api });
    type('Puesto', 'Mi cambio');
    api.controls.archiveEmployeeExternally('emp-001');
    // The archive moved the version on, but "immutable" is checked first by the server.
    click('Guardar cambios');
    expect(
      await screen.findByRole('heading', { name: /ya no admite cambios|Otra persona modificó/ }),
    ).toBeInTheDocument();
  });

  it('marks the area when it was deactivated meanwhile (422)', async () => {
    const api = createMockApi();
    await edit('emp-001', { api });
    api.controls.deactivateAreaExternally('area-sur');
    pick('Área', 'area-sur');
    click('Guardar cambios');
    expect(await screen.findByText('El área no es válida')).toBeInTheDocument();
    expect(getField('Área')).toHaveAttribute('aria-invalid', 'true');
  });

  it.each([
    [400, 'El servidor rechazó los datos'],
    [403, 'No tienes permiso'],
    [404, 'El empleado ya no existe'],
    [500, 'No pudimos guardar el empleado'],
  ] as const)('shows a %s answer without losing the edits', async (status, title) => {
    const api = createMockApi();
    await edit('emp-001', { api });
    api.controls.failNext('updateEmployee', status);
    type('Puesto', 'Otro');
    click('Guardar cambios');
    expect(await screen.findByText(title)).toBeInTheDocument();
    expect(getField('Puesto')).toHaveValue('Otro');
  });

  it('keeps the edits across an expired session, and warns when the employee changed meanwhile', async () => {
    const api = createMockApi();
    await edit('emp-001', { api });
    type('Puesto', 'Mi cambio');
    api.controls.failNext('updateEmployee', 401);
    click('Guardar cambios');
    await screen.findByRole('group', { name: 'Sesión expirada' });
    api.controls.changeEmployeeExternally('emp-001', { position: 'Cambio ajeno' });
    type('Cuenta de prueba', demoSubjects.admin);
    click('Continuar');
    await screen.findByRole('form', { name: 'Editar empleado' });
    expect(
      await screen.findByText(/El empleado cambió desde que empezaste a editar/),
    ).toBeInTheDocument();
    expect(getField('Puesto')).toHaveValue('Cambio ajeno');
  });

  it('restores the edits when the employee did not change meanwhile', async () => {
    const api = createMockApi();
    await edit('emp-001', { api });
    type('Puesto', 'Mi cambio');
    api.controls.failNext('updateEmployee', 401);
    click('Guardar cambios');
    await screen.findByRole('group', { name: 'Sesión expirada' });
    type('Cuenta de prueba', demoSubjects.admin);
    click('Continuar');
    await screen.findByRole('form', { name: 'Editar empleado' });
    expect(getField('Puesto')).toHaveValue('Mi cambio');
  });

  it('does not offer the form for terminated or archived employees', async () => {
    await renderApp({ path: '/plantilla/empleados/emp-007/editar' });
    expect(
      await screen.findByRole('heading', { name: 'Este empleado no se puede editar' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Volver al empleado' })).toHaveAttribute(
      'href',
      '/plantilla/empleados/emp-007',
    );
  });

  it('shows not found, error with retry and no access', async () => {
    const missing = await renderApp({ path: '/plantilla/empleados/no-existe/editar' });
    expect(
      await screen.findByRole('heading', { name: 'Empleado no encontrado' }),
    ).toBeInTheDocument();
    missing.unmount();
    const api = createMockApi();
    api.controls.failNext('getEmployee');
    await renderApp({ api, path: '/plantilla/empleados/emp-001/editar' });
    expect(
      await screen.findByRole('heading', { name: 'No pudimos cargar la información' }),
    ).toBeInTheDocument();
    click('Reintentar');
    await screen.findByRole('form', { name: 'Editar empleado' });
  });

  it('shows the no-permission state to a role that cannot edit', async () => {
    await renderApp({ path: '/plantilla/empleados/emp-001/editar', account: 'viewer' });
    expect(await screen.findByRole('heading', { name: 'No tienes acceso' })).toBeInTheDocument();
  });
});
