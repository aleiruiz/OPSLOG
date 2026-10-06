import { act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createMockApi, demoSubjects, type MockApi } from '../app/mockApi';
import {
  click,
  deferred,
  fireEvent,
  renderApp,
  screen,
  type,
  waitFor,
  within,
} from '../app/test/utils';
import { demoEmployees, makeEmployeeDetail } from './fixtures';

async function open(id: string, options: Parameters<typeof renderApp>[0] = {}) {
  const view = await renderApp({ path: `/plantilla/empleados/${id}`, ...options });
  await screen.findByRole('heading', { level: 1 });
  await waitFor(() => expect(screen.queryByRole('heading', { name: 'Cargando' })).toBeNull());
  return view;
}
const dd = (label: string) =>
  (screen.getByText(label, { selector: 'dt' }).nextElementSibling as HTMLElement) ?? null;
const confirmDialog = async (title: string) => {
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByRole('heading', { name: title })).toBeInTheDocument();
  return dialog;
};

/** Everything personal that the fixtures hold for `emp-001`. */
const PERSONAL = /EJEM800101HDFXXX01|\+525555550101|ana\.garcia|empleado1@ejemplo|LIC-100001/;

describe('employee detail: data', () => {
  it('shows the data of a driver with area, status, reason, fitness and license', async () => {
    await open('emp-001');
    expect(screen.getByRole('heading', { name: 'Ana García López', level: 1 })).toBeInTheDocument();
    expect(screen.getByText('Conductor · Conductor')).toBeInTheDocument();
    expect(dd('Número de empleado')).toHaveTextContent('E-0001');
    expect(dd('Área')).toHaveTextContent('Norte');
    expect(within(dd('Área')).getByRole('link')).toHaveAttribute(
      'href',
      '/plantilla/areas/area-norte',
    );
    expect(dd('Estado')).toHaveTextContent('Activo');
    expect(dd('Motivo del estado')).toHaveTextContent('Alta');
    expect(dd('Aptitud para operar')).toHaveTextContent('Apto para operar');
    expect(dd('Tipo de licencia')).toHaveTextContent('C');
    expect(dd('Vigencia de la licencia')).toHaveTextContent('31 mar 2028');
    expect(dd('Fecha de ingreso')).toHaveTextContent('2022');
  });

  it('explains why a driver is not fit to operate, in plain words', async () => {
    await open('emp-007');
    expect(dd('Aptitud para operar')).toHaveTextContent('No apto para operar');
    expect(
      within(dd('Aptitud para operar'))
        .getAllByRole('listitem')
        .map((i) => i.textContent),
    ).toEqual(['El empleado no está activo', 'La licencia está vencida']);
  });

  it('has no fitness or license rows for a dispatcher, and shows empty optional fields as such', async () => {
    const seed = [
      makeEmployeeDetail({
        id: 'emp-d',
        kind: 'dispatcher',
        employeeNumber: null,
        position: null,
        hireDate: null,
        licenseType: null,
        licenseExpiresOn: null,
      }),
    ];
    await open('emp-d', { api: createMockApi({ employees: seed }) });
    expect(screen.queryByText('Aptitud para operar')).toBeNull();
    expect(screen.queryByText('Tipo de licencia')).toBeNull();
    expect(dd('Número de empleado')).toHaveTextContent('Sin número');
    expect(dd('Puesto')).toHaveTextContent('Sin puesto');
    expect(dd('Fecha de ingreso')).toHaveTextContent('Sin fecha');
  });

  it('shows a driver without license data with explicit placeholders', async () => {
    await open('emp-005');
    expect(dd('Tipo de licencia')).toHaveTextContent('Sin tipo');
    expect(dd('Vigencia de la licencia')).toHaveTextContent('Sin vigencia');
  });

  it('shows the history of status and area changes with their reasons, newest first', async () => {
    const api = createMockApi();
    const admin = await open('emp-002', { api });
    await act(async () => {
      await api.employees.update('emp-002', { version: 1, areaId: 'area-sur' });
      await api.employees.changeStatus('emp-002', {
        version: 2,
        status: 'suspended',
        reason: 'Revisión interna',
      });
    });
    admin.unmount();
    await open('emp-002', { api });
    const history = screen.getByRole('list', { name: 'Línea de tiempo' });
    const items = within(history).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('Estado: de Activo a Suspendido');
    expect(items[0]).toHaveTextContent('Motivo: Revisión interna');
    expect(items[1]).toHaveTextContent('Cambió de área: de «Centro» a «Sur»');
    expect(items[1]).not.toHaveTextContent('Motivo');
    expect(items[2]).toHaveTextContent('Alta con estado Activo');
    expect(items[2]).toHaveTextContent('Por user-admin · versión 1');
  });

  it('pages a long history with the cursor, and reports a failed or expired page load', async () => {
    const { api } = await open('emp-001');
    const history = () => within(screen.getByRole('list', { name: 'Línea de tiempo' }));
    expect(history().getAllByRole('listitem')).toHaveLength(25);
    api.controls.failNext('employeeHistory');
    click('Cargar más historial');
    expect(await screen.findByText('No pudimos cargar más historial.')).toBeInTheDocument();
    click('Cargar más historial');
    await waitFor(() => expect(history().getAllByRole('listitem')).toHaveLength(31));
    expect(screen.queryByRole('button', { name: 'Cargar más historial' })).toBeNull();
  });

  it('expires the session when loading more history answers 401', async () => {
    const { api } = await open('emp-001');
    api.controls.failNext('employeeHistory', 401);
    click('Cargar más historial');
    await screen.findByRole('group', { name: 'Sesión expirada' });
  });

  it('ignores a history page that arrives after the history was reloaded', async () => {
    const api = createMockApi();
    const real = api.employees.history;
    const gate = deferred();
    await open('emp-001', { api });
    api.employees.history = async (id, query) => {
      if (query?.cursor) await gate.promise;
      return real(id, query);
    };
    click('Cargar más historial');
    // A status change refreshes the first page of the history while the second one is still in flight.
    fireEvent.click(screen.getByRole('button', { name: 'Cambiar estado' }));
    fireEvent.change(screen.getByLabelText(/^Nuevo estado/), { target: { value: 'inactive' } });
    type('Motivo', 'Licencia');
    click('Cambiar estado');
    await screen.findByText('Estado cambiado a Inactivo.');
    await act(async () => gate.resolve());
    await new Promise((resolve) => setTimeout(resolve, 20));
    const items = within(screen.getByRole('list', { name: 'Línea de tiempo' })).getAllByRole(
      'listitem',
    );
    expect(items).toHaveLength(25);
  });

  it('shows the history error with a retry that does not hide the employee', async () => {
    const api = createMockApi();
    api.controls.failNext('employeeHistory');
    await open('emp-002', { api });
    expect(
      screen.getByRole('heading', { name: 'Luis Hernández Ruiz', level: 1 }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('heading', { name: 'No pudimos cargar la información' }),
    ).toBeInTheDocument();
    click('Reintentar');
    await screen.findByRole('list', { name: 'Línea de tiempo' });
  });

  it('shows the not-found, error, no-permission and expired states', async () => {
    const missing = await renderApp({ path: '/plantilla/empleados/no-existe' });
    expect(
      await screen.findByRole('heading', { name: 'Empleado no encontrado' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Volver a empleados' })).toHaveAttribute(
      'href',
      '/plantilla/empleados',
    );
    missing.unmount();
    const api = createMockApi();
    api.controls.failNext('getEmployee');
    const failed = await renderApp({ api, path: '/plantilla/empleados/emp-001' });
    expect(
      await screen.findByRole('heading', { name: 'No pudimos cargar la información' }),
    ).toBeInTheDocument();
    click('Reintentar');
    await screen.findByRole('heading', { name: 'Ana García López', level: 1 });
    failed.unmount();
    const denied = createMockApi();
    denied.controls.failNext('getEmployee', 403);
    await renderApp({ api: denied, path: '/plantilla/empleados/emp-001' });
    expect(await screen.findByRole('heading', { name: 'No tienes acceso' })).toBeInTheDocument();
  });

  it('keeps the employee when only the structure fails to load, naming the area by its id', async () => {
    const api = createMockApi();
    api.controls.failNext('listAreas');
    await open('emp-001', { api });
    expect(dd('Área')).toHaveTextContent('area-norte');
  });

  it('expires the session when the structure answers 401', async () => {
    const api = createMockApi();
    api.controls.failNext('listAreas', 401);
    await renderApp({ api, path: '/plantilla/empleados/emp-001' });
    await screen.findByRole('group', { name: 'Sesión expirada' });
  });

  it('shows the result of the previous screen once and removes it from the address bar', async () => {
    await renderApp({ path: '/plantilla/empleados/emp-001?aviso=creado' });
    expect(await screen.findByText('Empleado creado.')).toBeInTheDocument();
    await waitFor(() => expect(window.location.search).toBe(''));
    expect(screen.getByText('Empleado creado.').closest('[tabindex="-1"]')).toHaveFocus();
    expect(window.location.pathname).toBe('/plantilla/empleados/emp-001');
  });

  it('shows the saved-changes notice, and ignores an unknown one', async () => {
    const saved = await renderApp({ path: '/plantilla/empleados/emp-001?aviso=guardado' });
    expect(await screen.findByText('Cambios guardados.')).toBeInTheDocument();
    saved.unmount();
    await renderApp({ path: '/plantilla/empleados/emp-001?aviso=otra-cosa' });
    await screen.findByRole('heading', { name: 'Ana García López', level: 1 });
    expect(screen.queryByRole('region', { name: 'Notificaciones' })).toBeNull();
  });
});

describe('employee detail: personal data', () => {
  it('keeps the personal data out of the page until the person asks to see it', async () => {
    const { container } = await open('emp-001');
    const section = screen.getByRole('region', { name: 'Datos personales' });
    expect(container).not.toHaveTextContent(PERSONAL);
    expect(within(section).getAllByText('Oculto')).toHaveLength(4);
    expect(section).toHaveTextContent('Identificación');
    expect(section).toHaveTextContent('Número de licencia');
    click('Mostrar datos personales');
    expect(within(section).getByText('CURP · EJEM800101HDFXXX01')).toBeInTheDocument();
    expect(within(section).getByText('+525555550101')).toBeInTheDocument();
    expect(within(section).getByText('empleado1@ejemplo.test')).toBeInTheDocument();
    expect(within(section).getByText('LIC-100001')).toBeInTheDocument();
    click('Ocultar datos personales');
    expect(container).not.toHaveTextContent(PERSONAL);
  });

  it('asks the server once per load: showing and hiding does not read (or audit) anything again', async () => {
    const api = createMockApi();
    const get = vi.spyOn(api.employees, 'get');
    await open('emp-001', { api });
    expect(get).toHaveBeenCalledTimes(1);
    expect(api.controls.employeeAudit()).toEqual([
      { action: 'employee.pii_viewed', id: 'emp-001' },
    ]);
    click('Mostrar datos personales');
    click('Ocultar datos personales');
    expect(get).toHaveBeenCalledTimes(1);
    expect(api.controls.employeeAudit()).toHaveLength(1);
  });

  it('hides the data again after a change, because the page is a new version', async () => {
    await open('emp-001');
    click('Mostrar datos personales');
    expect(screen.getByText('+525555550101')).toBeInTheDocument();
    click('Cambiar estado');
    fireEvent.change(screen.getByLabelText(/^Nuevo estado/), { target: { value: 'inactive' } });
    type('Motivo', 'Licencia');
    click('Cambiar estado');
    await screen.findByText('Estado cambiado a Inactivo.');
    expect(screen.queryByText('+525555550101')).toBeNull();
    expect(screen.getByRole('button', { name: 'Mostrar datos personales' })).toBeInTheDocument();
  });

  it.each(['viewer', 'dispatch', 'mechanic'] as const)(
    'shows only a masked placeholder to %s: no values, no way to reveal them, nothing audited',
    async (account) => {
      const api = createMockApi();
      const { container } = await open('emp-001', { api, account });
      const section = screen.getByRole('region', { name: 'Datos personales' });
      expect(section).toHaveTextContent('Datos personales protegidos');
      expect(container).not.toHaveTextContent(PERSONAL);
      expect(within(section).getAllByText('Oculto')).toHaveLength(4);
      expect(screen.queryByRole('button', { name: /datos personales/i })).toBeNull();
      expect(api.controls.employeeAudit()).toEqual([]);
    },
  );

  it('tells a masked viewer which personal data exist, and which do not', async () => {
    const seed = [
      makeEmployeeDetail(
        {
          id: 'emp-p',
          kind: 'dispatcher',
          idType: null,
          licenseType: null,
          licenseExpiresOn: null,
        },
        { nationalId: null, phone: '+525555550101', email: null, licenseNumber: null },
      ),
    ];
    await open('emp-p', { api: createMockApi({ employees: seed }), account: 'viewer' });
    const section = screen.getByRole('region', { name: 'Datos personales' });
    expect(within(section).getAllByText('No registrado')).toHaveLength(2);
    expect(within(section).getAllByText('Oculto')).toHaveLength(1);
    // A dispatcher has no license number row.
    expect(screen.queryByText('Número de licencia')).toBeNull();
  });

  it('lets the personal-data reader see the values on request, without any edit action', async () => {
    await open('emp-001', { account: 'piiReader' });
    click('Mostrar datos personales');
    expect(screen.getByText('+525555550101')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Editar' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cambiar estado' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Archivar' })).toBeNull();
  });

  it('shows "No registrado" for personal data the employee does not have, even to the one who may see it', async () => {
    const seed = [
      makeEmployeeDetail(
        { id: 'emp-n', kind: 'other', idType: null, licenseType: null, licenseExpiresOn: null },
        { nationalId: null, phone: null, email: null, licenseNumber: null },
      ),
    ];
    const api = createMockApi({ employees: seed });
    await open('emp-n', { api });
    const section = screen.getByRole('region', { name: 'Datos personales' });
    expect(within(section).getAllByText('No registrado')).toHaveLength(3);
    // Nothing to disclose, nothing audited.
    expect(api.controls.employeeAudit()).toEqual([]);
  });

  it('shows an identification type that the catalog does not list by its code', async () => {
    const seed = [makeEmployeeDetail({ id: 'emp-i', idType: 'dni' })];
    await open('emp-i', { api: createMockApi({ employees: seed }) });
    click('Mostrar datos personales');
    expect(screen.getByText('DNI · EJEM800101HDFXXX01')).toBeInTheDocument();
  });

  it('shows an identification without a type as just the number', async () => {
    const seed = [makeEmployeeDetail({ id: 'emp-i', idType: null })];
    await open('emp-i', { api: createMockApi({ employees: seed }) });
    click('Mostrar datos personales');
    expect(screen.getByText('EJEM800101HDFXXX01')).toBeInTheDocument();
  });
});

describe('employee detail: actions by permission', () => {
  const actions = () => ({
    edit: screen.queryByRole('link', { name: 'Editar' }),
    status: screen.queryByRole('button', { name: 'Cambiar estado' }),
    archive: screen.queryByRole('button', { name: 'Archivar' }),
  });

  it('gives the administrator everything', async () => {
    await open('emp-001');
    const { edit, status, archive } = actions();
    expect(edit).toHaveAttribute('href', '/plantilla/empleados/emp-001/editar');
    expect(status).toBeInTheDocument();
    expect(archive).toBeInTheDocument();
  });

  it('gives the dispatcher edit and status, but not archive', async () => {
    await open('emp-001', { account: 'dispatch' });
    const { edit, status, archive } = actions();
    expect(edit).toBeInTheDocument();
    expect(status).toBeInTheDocument();
    expect(archive).toBeNull();
  });

  it('gives a read-only role no action', async () => {
    await open('emp-001', { account: 'viewer' });
    expect(Object.values(actions())).toEqual([null, null, null]);
  });

  it('offers only archiving for a terminated employee, with an explanation', async () => {
    await open('emp-007');
    expect(screen.getByRole('heading', { name: 'Empleado dado de baja' })).toBeInTheDocument();
    const { edit, status, archive } = actions();
    expect(edit).toBeNull();
    expect(status).toBeNull();
    expect(archive).toBeInTheDocument();
  });

  it('offers no action for an archived employee, with an explanation and the date', async () => {
    const seed = [makeEmployeeDetail({ archivedAt: '2026-09-30T10:00:00.000Z' })];
    await open('emp-001', { api: createMockApi({ employees: seed }) });
    expect(screen.getByRole('heading', { name: 'Empleado archivado' })).toBeInTheDocument();
    expect(Object.values(actions())).toEqual([null, null, null]);
    expect(dd('Archivado')).toBeInTheDocument();
    expect(dd('Aptitud para operar')).toHaveTextContent('No apto para operar');
  });
});

describe('employee detail: change status', () => {
  const openPanel = async (options: Parameters<typeof renderApp>[0] = {}, id = 'emp-001') => {
    const view = await open(id, options);
    click('Cambiar estado');
    return view;
  };
  const choose = (status: string, reason?: string) => {
    fireEvent.change(screen.getByLabelText(/^Nuevo estado/), { target: { value: status } });
    if (reason !== undefined) type('Motivo', reason);
  };
  const submit = () =>
    fireEvent.click(screen.getAllByRole('button', { name: 'Cambiar estado' }).at(-1)!);

  it('opens a panel on its first field, offers only the states the matrix allows and closes with Cancelar', async () => {
    await openPanel();
    const panel = screen.getByRole('form', { name: 'Cambiar estado' });
    expect(within(panel).getByLabelText(/^Nuevo estado/)).toHaveFocus();
    const options = within(panel)
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(options).toEqual(['Elige un estado', 'Inactivo', 'Suspendido', 'Baja']);
    // The opening button gives way to the panel.
    expect(
      screen.queryByRole('button', { name: 'Cambiar estado', description: '' })?.closest('form'),
    ).toBe(panel);
    click('Cancelar');
    expect(screen.queryByRole('form', { name: 'Cambiar estado' })).toBeNull();
  });

  it('offers a suspended employee a way back to active, but never the same state', async () => {
    await openPanel({}, 'emp-005');
    const panel = screen.getByRole('form', { name: 'Cambiar estado' });
    expect(
      within(panel)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Elige un estado', 'Activo', 'Inactivo', 'Baja']);
  });

  it('asks for the new state and the reason before sending anything, and focuses the first problem', async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api.employees, 'changeStatus');
    await openPanel({ api });
    submit();
    expect(screen.getByText('Elige el nuevo estado.')).toBeInTheDocument();
    expect(screen.getByLabelText(/^Nuevo estado/)).toHaveFocus();
    choose('inactive');
    submit();
    expect(screen.getByText(/Escribe el motivo del cambio/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Motivo/)).toHaveFocus();
    expect(screen.getByLabelText(/^Motivo/)).toHaveAttribute('aria-invalid', 'true');
    type('Motivo', 'x'.repeat(201));
    submit();
    expect(screen.getByText(/Escribe el motivo del cambio/)).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
    // Correcting a field clears its message.
    type('Motivo', 'Licencia médica');
    expect(screen.queryByText(/Escribe el motivo del cambio/)).toBeNull();
  });

  it('changes the status with the trimmed reason, announces it, updates the page and the history', async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api.employees, 'changeStatus');
    await openPanel({ api });
    choose('suspended', '  Revisión interna  ');
    submit();
    expect(await screen.findByText('Estado cambiado a Suspendido.')).toBeInTheDocument();
    expect(spy).toHaveBeenCalledWith('emp-001', {
      version: 31,
      status: 'suspended',
      reason: 'Revisión interna',
    });
    expect(
      screen.getByText('Estado cambiado a Suspendido.').closest('[tabindex="-1"]'),
    ).toHaveFocus();
    expect(screen.queryByRole('form', { name: 'Cambiar estado' })).toBeNull();
    expect(dd('Estado')).toHaveTextContent('Suspendido');
    expect(dd('Motivo del estado')).toHaveTextContent('Revisión interna');
    expect(dd('Aptitud para operar')).toHaveTextContent('No apto para operar');
    await waitFor(() =>
      expect(screen.getAllByText('Estado: de Activo a Suspendido').length).toBeGreaterThan(0),
    );
    expect(api.controls.employees().find((e) => e.id === 'emp-001')?.status).toBe('suspended');
  });

  it('shows the busy state while the request runs and cannot be submitted twice', async () => {
    const api = createMockApi();
    const gate = deferred();
    const real = api.employees.changeStatus;
    const spy = vi.spyOn(api.employees, 'changeStatus').mockImplementation(async (id, change) => {
      await gate.promise;
      return real(id, change);
    });
    await openPanel({ api });
    choose('inactive', 'Licencia');
    submit();
    expect(await screen.findByRole('button', { name: 'Cargando…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancelar' })).toBeDisabled();
    fireEvent.submit(screen.getByRole('form', { name: 'Cambiar estado' }));
    expect(spy).toHaveBeenCalledTimes(1);
    act(() => gate.resolve());
    await screen.findByText('Estado cambiado a Inactivo.');
  });

  it('asks for confirmation before a termination, showing the reason, and can go back to the panel', async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api.employees, 'changeStatus');
    await openPanel({ api });
    choose('terminated', 'Renuncia voluntaria');
    submit();
    const dialog = await confirmDialog('Dar de baja a Ana García López');
    expect(dialog).toHaveAccessibleDescription(
      /La baja es definitiva.*Motivo: Renuncia voluntaria/,
    );
    expect(within(dialog).getByRole('button', { name: 'Cancelar' })).toHaveFocus();
    expect(spy).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // The panel is still there with what was typed.
    expect(screen.getByLabelText(/^Motivo/)).toHaveValue('Renuncia voluntaria');
    submit();
    fireEvent.keyDown(await confirmDialog('Dar de baja a Ana García López'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(spy).not.toHaveBeenCalled();
  });

  it('terminates after the confirmation: read-only record, banner, no edit or status actions', async () => {
    const api = createMockApi();
    await openPanel({ api });
    choose('terminated', 'Renuncia voluntaria');
    submit();
    const dialog = await confirmDialog('Dar de baja a Ana García López');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Dar de baja' }));
    expect(await screen.findByText('Empleado dado de baja.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('heading', { name: 'Empleado dado de baja' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Editar' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cambiar estado' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Archivar' })).toBeInTheDocument();
    expect(api.controls.employees().find((e) => e.id === 'emp-001')?.status).toBe('terminated');
  });

  it('shows the busy state of a termination and cannot dismiss the dialog meanwhile', async () => {
    const api = createMockApi();
    const gate = deferred();
    const real = api.employees.changeStatus;
    vi.spyOn(api.employees, 'changeStatus').mockImplementation(async (id, change) => {
      await gate.promise;
      return real(id, change);
    });
    await openPanel({ api });
    choose('terminated', 'Renuncia');
    submit();
    const dialog = await confirmDialog('Dar de baja a Ana García López');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Dar de baja' }));
    expect(await within(dialog).findByRole('button', { name: 'Cargando…' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Cancelar' })).toBeDisabled();
    act(() => gate.resolve());
    await screen.findByText('Empleado dado de baja.');
  });

  it('explains a version conflict in the panel and reloads the data on request', async () => {
    const api = createMockApi();
    await openPanel({ api });
    api.controls.changeEmployeeExternally('emp-001', { position: 'Cambiado' });
    choose('inactive', 'Licencia');
    submit();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Otra persona modificó este empleado');
    expect(alert.closest('[tabindex="-1"]')).toHaveFocus();
    click('Recargar datos');
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Cambiar estado' })).toBeNull());
    await waitFor(() =>
      expect(screen.getAllByText('Cambiado', { exact: false }).length).toBeGreaterThan(0),
    );
  });

  it('explains a version conflict inside the termination dialog', async () => {
    const api = createMockApi();
    await openPanel({ api });
    choose('terminated', 'Renuncia');
    submit();
    api.controls.changeEmployeeExternally('emp-001', { position: 'Cambiado' });
    const dialog = await confirmDialog('Dar de baja a Ana García López');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Dar de baja' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Otra persona modificó este empleado',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Recargar datos' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('explains that the employee changed state meanwhile (409 invalid_transition)', async () => {
    const api = createMockApi();
    await openPanel({ api });
    choose('inactive', 'Licencia');
    // Another person already moved the employee to the state being chosen.
    await api.employees.changeStatus('emp-001', {
      version: 31,
      status: 'inactive',
      reason: 'Otro',
    });
    // The copy on screen is now stale: the version check answers first.
    submit();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Otra persona modificó este empleado',
    );
  });

  it.each([
    [400, /rechazó el motivo/],
    [403, /No tienes permiso para cambiar el estado/],
    [404, /ya no existe/],
    [500, /No pudimos cambiar el estado/],
  ] as const)(
    'shows a %s answer in the panel without losing what was typed',
    async (status, text) => {
      const api = createMockApi();
      await openPanel({ api });
      api.controls.failNext('changeEmployeeStatus', status);
      choose('inactive', 'Licencia');
      submit();
      expect(await screen.findByRole('alert')).toHaveTextContent(text);
      expect(screen.getByLabelText(/^Motivo/)).toHaveValue('Licencia');
      expect(screen.queryByRole('button', { name: 'Recargar datos' })).toBeNull();
    },
  );

  it('shows the answer of a rejected termination inside the dialog', async () => {
    const api = createMockApi();
    await openPanel({ api });
    choose('terminated', 'Renuncia');
    submit();
    api.controls.failNext('changeEmployeeStatus', 500);
    const dialog = await confirmDialog('Dar de baja a Ana García López');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Dar de baja' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      /No pudimos cambiar el estado/,
    );
  });

  it('closes the dialog and the panel when the session expires, and lets the person try again after signing in', async () => {
    const api = createMockApi();
    await openPanel({ api });
    choose('terminated', 'Renuncia');
    submit();
    const dialog = await confirmDialog('Dar de baja a Ana García López');
    api.controls.expireSession();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Dar de baja' }));
    await screen.findByRole('group', { name: 'Sesión expirada' });
    expect(screen.queryByRole('dialog')).toBeNull();
    type('Cuenta de prueba', demoSubjects.admin);
    click('Continuar');
    await screen.findByRole('heading', { name: 'Ana García López', level: 1 });
  });

  it('expires the session on a 401 from the panel', async () => {
    const api = createMockApi();
    await openPanel({ api });
    api.controls.failNext('changeEmployeeStatus', 401);
    choose('inactive', 'Licencia');
    submit();
    await screen.findByRole('group', { name: 'Sesión expirada' });
  });

  it('lets the dispatcher change the status, with the same flow', async () => {
    await openPanel({ account: 'dispatch' });
    choose('inactive', 'Licencia');
    submit();
    expect(await screen.findByText('Estado cambiado a Inactivo.')).toBeInTheDocument();
  });
});

describe('employee detail: archive', () => {
  const openArchive = async (
    api: MockApi = createMockApi(),
    id = 'emp-002',
    title = 'Archivar a Luis Hernández Ruiz',
  ) => {
    await open(id, { api });
    fireEvent.click(screen.getByRole('button', { name: 'Archivar' }));
    return confirmDialog(title);
  };

  it('asks for confirmation, can be cancelled and closed with Escape', async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api.employees, 'archive');
    const dialog = await openArchive(api);
    expect(dialog).toHaveAccessibleDescription(/no se podrá editar/);
    expect(within(dialog).getByRole('button', { name: 'Cancelar' })).toHaveFocus();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Archivar' }));
    fireEvent.keyDown(await confirmDialog('Archivar a Luis Hernández Ruiz'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(spy).not.toHaveBeenCalled();
  });

  it('archives, announces the result in a focused notice and makes the record read-only', async () => {
    const api = createMockApi();
    const dialog = await openArchive(api);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archivar empleado' }));
    expect(await screen.findByText('Empleado archivado.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByText('Empleado archivado.').closest('[tabindex="-1"]')).toHaveFocus();
    expect(screen.getByRole('heading', { name: 'Empleado archivado' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archivar' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Editar' })).toBeNull();
    expect(api.controls.employees().find((e) => e.id === 'emp-002')?.archivedAt).not.toBeNull();
    // The personal data held by the page survives the change and stays hidden.
    expect(screen.getByRole('button', { name: 'Mostrar datos personales' })).toBeInTheDocument();
  });

  it('shows the busy state and cannot be dismissed while archiving', async () => {
    const api = createMockApi();
    const gate = deferred();
    const real = api.employees.archive;
    vi.spyOn(api.employees, 'archive').mockImplementation(async (id, version) => {
      await gate.promise;
      return real(id, version);
    });
    const dialog = await openArchive(api);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archivar empleado' }));
    expect(await within(dialog).findByRole('button', { name: 'Cargando…' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Cancelar' })).toBeDisabled();
    act(() => gate.resolve());
    await screen.findByText('Empleado archivado.');
  });

  it('explains a version conflict inside the dialog and reloads on request', async () => {
    const api = createMockApi();
    const dialog = await openArchive(api);
    api.controls.changeEmployeeExternally('emp-002', { position: 'Cambiado' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archivar empleado' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Otra persona modificó este empleado',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Recargar datos' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await screen.findByRole('heading', { name: 'Luis Hernández Ruiz', level: 1 });
  });

  it('says that the employee was already archived by someone else', async () => {
    const api = createMockApi();
    const dialog = await openArchive(api);
    api.controls.archiveEmployeeExternally('emp-002');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archivar empleado' }));
    // The version moved on too, and the stale check comes after "already archived".
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Este empleado ya estaba archivado.',
    );
  });

  it.each([
    [403, /No tienes permiso para archivar/],
    [404, /ya no existe/],
    [500, /No pudimos archivar al empleado/],
  ] as const)('shows a %s answer inside the dialog', async (status, text) => {
    const api = createMockApi();
    const dialog = await openArchive(api);
    api.controls.failNext('archiveEmployee', status);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archivar empleado' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(text);
  });

  it('closes the dialog when the session expires', async () => {
    const api = createMockApi();
    const dialog = await openArchive(api);
    api.controls.failNext('archiveEmployee', 401);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archivar empleado' }));
    await screen.findByRole('group', { name: 'Sesión expirada' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('can archive a terminated employee', async () => {
    const api = createMockApi({ employees: demoEmployees() });
    const dialog = await openArchive(api, 'emp-007', 'Archivar a Elena Domínguez Paz');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archivar empleado' }));
    expect(await screen.findByText('Empleado archivado.')).toBeInTheDocument();
  });
});
