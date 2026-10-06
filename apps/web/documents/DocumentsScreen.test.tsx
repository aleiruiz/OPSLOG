import { act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createMockApi, demoSubjects } from '../app/mockApi';
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
import { demoDocuments, makeDocument } from './fixtures';

/** Exact label match: the status badges also carry "Estado: ..." accessible names. */
const exact = (label: string) => screen.getByLabelText(label);
const set = (label: string, value: string) => fireEvent.change(exact(label), { target: { value } });
const rowsOf = () => screen.getAllByRole('row').slice(1);
const list = (options: Parameters<typeof renderApp>[0] = {}) =>
  renderApp({ path: '/flota/documentos', ...options });

describe('document list', () => {
  it('shows the documents with labelled types, owners and statuses, and no technical ids', async () => {
    await list();
    const table = await screen.findByRole('table', { name: 'Documentos (28)' });
    expect(rowsOf()).toHaveLength(25);
    for (const label of ['Vigente', 'Por vencer', 'Vencido'])
      expect(table).toHaveTextContent(label);
    expect(table).toHaveTextContent('Tarjeta de circulación');
    expect(table).toHaveTextContent('Examen médico');
    expect(table).not.toHaveTextContent(/registration_card|medical_exam|expiring|expired/);
    // Ordered by expiry: the most overdue first, with the days noted.
    expect(rowsOf()[0]).toHaveTextContent('Venció hace 40 días');
    expect(table).toHaveTextContent('Vence hoy');
    expect(table).toHaveTextContent('Faltan 5 días');
    expect(screen.getByRole('link', { name: 'Tarjeta de circulación 001' })).toHaveAttribute(
      'href',
      '/flota/documentos/doc-001',
    );
  });

  it('names the vehicle owner by its economic number, and an employee owner by its kind', async () => {
    await list();
    const table = await screen.findByRole('table');
    await waitFor(() =>
      expect(
        within(table).getAllByRole('link', { name: /^Vehículo ECO-\d+$/ }).length,
      ).toBeGreaterThan(5),
    );
    expect(within(table).getAllByText('Empleado').length).toBeGreaterThan(0);
  });

  it('falls back to a generic owner label when the vehicles cannot be loaded', async () => {
    const api = createMockApi();
    api.controls.failNext('listVehicles');
    await list({ api });
    const table = await screen.findByRole('table');
    expect(within(table).getAllByText('Vehículo').length).toBeGreaterThan(0);
    // Without vehicles the vehicle filter is not offered.
    set('Propietario', 'vehicle');
    await screen.findByRole('table');
    expect(screen.queryByLabelText('Vehículo')).toBeNull();
  });

  it('is reached from the navigation under "Flota" and highlights it', async () => {
    await renderApp();
    const link = await screen.findByRole('link', { name: 'Documentos' });
    expect(link).not.toHaveAttribute('aria-current');
    link.click();
    await screen.findByRole('heading', { name: 'Documentos', level: 1 });
    expect(screen.getByRole('link', { name: 'Documentos' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(document.title).toBe('Documentos · Transportes Demo SA · OPSLOG');
  });

  it('loads further pages with the cursor and keeps them until a filter changes', async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api.documents, 'list');
    await list({ api });
    await screen.findByRole('table');
    click('Cargar más documentos');
    await waitFor(() => expect(rowsOf()).toHaveLength(28));
    expect(spy).toHaveBeenLastCalledWith({ limit: 25, cursor: 'mock:25' });
    expect(screen.queryByRole('button', { name: 'Cargar más documentos' })).toBeNull();
    set('Estado', 'valid');
    await waitFor(() =>
      expect(screen.getByRole('table', { name: /Documentos \(\d+\)/ })).toBeInTheDocument(),
    );
    expect(spy).toHaveBeenLastCalledWith({ limit: 25, status: 'valid' });
  });

  it('filters by status, owner, vehicle, type and archived, and clears the filters', async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api.documents, 'list');
    await list({ api });
    await screen.findByRole('table', { name: 'Documentos (28)' });
    set('Estado', 'expired');
    await waitFor(() => expect(spy).toHaveBeenLastCalledWith({ limit: 25, status: 'expired' }));
    set('Propietario', 'employee');
    await waitFor(() =>
      expect(spy).toHaveBeenLastCalledWith({ limit: 25, status: 'expired', ownerType: 'employee' }),
    );
    // The employee catalog is offered, and the vehicle filter is not.
    expect(screen.queryByLabelText('Vehículo')).toBeNull();
    set('Propietario', 'vehicle');
    await waitFor(() => expect(screen.getByLabelText('Vehículo')).toBeInTheDocument());
    await waitFor(() =>
      expect(within(exact('Vehículo')).getAllByRole('option').length).toBeGreaterThan(20),
    );
    set('Vehículo', 'veh-001');
    set('Tipo de documento', 'registration_card');
    set('Archivados', 'true');
    await waitFor(() =>
      expect(spy).toHaveBeenLastCalledWith({
        limit: 25,
        status: 'expired',
        ownerType: 'vehicle',
        ownerId: 'veh-001',
        typeCode: 'registration_card',
        includeArchived: 'true',
      }),
    );
    click('Limpiar filtros');
    await screen.findByRole('table', { name: 'Documentos (28)' });
    expect(exact('Estado')).toHaveValue('');
    expect(exact('Propietario')).toHaveValue('');
  });

  it('drops a type filter that does not exist for the chosen owner, and keeps one that does', async () => {
    await list();
    await screen.findByRole('table');
    set('Tipo de documento', 'registration_card');
    set('Propietario', 'employee');
    expect(exact('Tipo de documento')).toHaveValue('');
    set('Tipo de documento', 'other');
    set('Propietario', 'vehicle');
    expect(exact('Tipo de documento')).toHaveValue('other');
    set('Propietario', '');
    expect(exact('Tipo de documento')).toHaveValue('other');
  });

  it('shows archived documents with a badge when asked, without edit or renew links', async () => {
    const seed = demoDocuments(3);
    seed[1] = { ...seed[1]!, archivedAt: '2026-09-30T10:00:00.000Z' };
    await list({ api: createMockApi({ documents: seed }) });
    await screen.findByRole('table', { name: 'Documentos (2)' });
    set('Archivados', 'true');
    const table = await screen.findByRole('table', { name: 'Documentos (3)' });
    expect(within(table).getByLabelText('Estado: Archivado')).toBeInTheDocument();
    expect(within(table).queryByRole('link', { name: /^Editar .*002/ })).toBeNull();
    expect(within(table).getByRole('link', { name: /^Editar .*001/ })).toBeInTheDocument();
    expect(within(table).getByRole('link', { name: /^Renovar .*001/ })).toBeInTheDocument();
  });

  it('shows a document without number or expiry plainly', async () => {
    const seed = [
      makeDocument({
        typeCode: 'other',
        expiresOn: null,
        daysToExpiry: null,
        documentNumber: null,
      }),
    ];
    await list({ api: createMockApi({ documents: seed }) });
    const table = await screen.findByRole('table');
    expect(table).toHaveTextContent('Sin vencimiento');
    expect(table).toHaveTextContent('—');
  });

  it('shows no results for filters that match nothing, an empty state without them, and keeps Enter from submitting', async () => {
    await list({ api: createMockApi({ documents: [makeDocument()] }) });
    await screen.findByRole('table');
    set('Estado', 'expired');
    expect(await screen.findByRole('heading', { name: 'Sin resultados' })).toBeInTheDocument();
    const form = screen.getByRole('search', { name: 'Filtros' });
    const event = new Event('submit', { bubbles: true, cancelable: true });
    form.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('invites to register the first document, and says so differently to read-only roles', async () => {
    const admin = await list({ api: createMockApi({ documents: [] }) });
    expect(
      await screen.findByRole('heading', { name: 'Aún no hay documentos' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Registra el primer documento/)).toBeInTheDocument();
    admin.unmount();
    await list({ api: createMockApi({ documents: [] }), account: 'viewer' });
    expect(
      await screen.findByText('Cuando se registren documentos aparecerán aquí.'),
    ).toBeInTheDocument();
  });

  it('offers create, edit and renew only to roles that hold those permissions', async () => {
    const admin = await list();
    await screen.findByRole('table');
    expect(screen.getByRole('link', { name: 'Nuevo documento' })).toHaveAttribute(
      'href',
      '/flota/documentos/nuevo',
    );
    expect(screen.getAllByRole('link', { name: /^Editar / }).length).toBeGreaterThan(0);
    admin.unmount();
    await list({ account: 'viewer' });
    await screen.findByRole('table');
    expect(screen.queryByRole('link', { name: 'Nuevo documento' })).toBeNull();
    expect(screen.queryByRole('link', { name: /^(Editar|Renovar) / })).toBeNull();
  });

  it('reports a recoverable error with retry, a 403 as no permission and a 401 as an expired session', async () => {
    const { api } = await list();
    await screen.findByRole('table');
    api.controls.failNext('listDocuments');
    set('Estado', 'valid');
    expect(
      await screen.findByRole('heading', { name: 'No pudimos cargar la información' }),
    ).toBeInTheDocument();
    click('Reintentar');
    await screen.findByRole('table');
    api.controls.failNext('listDocuments', 403);
    set('Estado', 'expiring');
    expect(await screen.findByRole('heading', { name: 'No tienes acceso' })).toBeInTheDocument();
    api.controls.expireSession();
    set('Estado', 'expired');
    await screen.findByRole('group', { name: 'Sesión expirada' });
    type('Cuenta de prueba', demoSubjects.admin);
    click('Continuar');
    await screen.findByRole('table', { name: /Documentos/ });
  });

  it('reports a failure when loading more, and expires the session on a 401', async () => {
    const { api } = await list();
    await screen.findByRole('table');
    api.controls.failNext('listDocuments');
    click('Cargar más documentos');
    expect(await screen.findByText('No pudimos cargar más documentos.')).toBeInTheDocument();
    api.controls.failNext('listDocuments', 401);
    click('Cargar más documentos');
    await screen.findByRole('group', { name: 'Sesión expirada' });
  });

  it('ignores a further page that arrives after the filters changed', async () => {
    const api = createMockApi();
    const real = api.documents.list;
    const gate = deferred();
    await list({ api });
    await screen.findByRole('table');
    api.documents.list = async (query) => {
      if (query?.cursor) await gate.promise;
      return real(query);
    };
    click('Cargar más documentos');
    set('Estado', 'expired');
    await waitFor(() =>
      expect(screen.getByRole('table', { name: /Documentos \(\d+\)/ })).toBeVisible(),
    );
    const filtered = rowsOf().length;
    await act(async () => gate.resolve());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(rowsOf()).toHaveLength(filtered);
  });

  it('navigates from "Nuevo documento" like a link', async () => {
    await list();
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('link', { name: 'Nuevo documento' }));
    await screen.findByRole('heading', { name: 'Nuevo documento', level: 1 });
    expect(window.location.pathname).toBe('/flota/documentos/nuevo');
  });
});
