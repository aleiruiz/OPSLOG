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
import type { ApiError, Document, Result } from '../app/types';
import { act } from '@testing-library/react';
import { demoDocuments, makeDocument } from './fixtures';
import { describeFailure } from './DocumentFormScreen';

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
const fail = (status: ApiError['status'], code: string): Result<Document> => ({
  ok: false,
  error: apiError(status, code),
});
const choose = (label: string, value: string) =>
  fireEvent.change(getField(label), { target: { value } });

async function openCreate(options: Parameters<typeof renderApp>[0] = {}) {
  const view = await renderApp({ path: '/flota/documentos/nuevo', ...options });
  await screen.findByRole('heading', { name: 'Nuevo documento', level: 1 });
  await screen.findByRole('option', { name: /ECO-001 · Nissan NP300/ });
  return view;
}

function fillCreate(overrides: Record<string, string> = {}) {
  const values: Record<string, string> = {
    Vehículo: 'veh-001',
    'Tipo de documento': 'registration_card',
    Título: 'Tarjeta 2026',
    'Número de documento': 'tc-77',
    'Fecha de emisión': '2026-01-10',
    'Fecha de vencimiento': '2027-01-10',
    ...overrides,
  };
  for (const [label, value] of Object.entries(values))
    if (label === 'Vehículo' || label === 'Tipo de documento') choose(label, value);
    else type(label, value);
}

describe('create document', () => {
  it('explains every missing field, focuses the first one and does not call the API', async () => {
    const api = createMockApi();
    const create = vi.spyOn(api.documents, 'create');
    await openCreate({ api });
    click('Crear documento');
    expect(screen.getByText('Elige el vehículo del documento.')).toBeInTheDocument();
    expect(screen.getByText('Elige el tipo de documento.')).toBeInTheDocument();
    expect(screen.getByText('Escribe el título del documento.')).toBeInTheDocument();
    expect(getField('Vehículo')).toHaveFocus();
    expect(getField('Vehículo')).toHaveAttribute('aria-invalid', 'true');
    expect(create).not.toHaveBeenCalled();
    // Correcting a field clears its message.
    choose('Vehículo', 'veh-001');
    expect(screen.queryByText('Elige el vehículo del documento.')).toBeNull();
  });

  it('asks for an expiry only for the types that always expire', async () => {
    await openCreate();
    expect(
      screen.getByText(/siempre vence: el vencimiento es obligatorio|opcional para este tipo/),
    ).toBeInTheDocument();
    choose('Tipo de documento', 'ownership_title');
    expect(screen.getByText(/El vencimiento es opcional/)).toBeInTheDocument();
    expect(getField('Fecha de vencimiento')).not.toBeRequired();
    choose('Tipo de documento', 'registration_card');
    expect(screen.getByText(/siempre vence/)).toBeInTheDocument();
    expect(getField('Fecha de vencimiento')).toBeRequired();
  });

  it('creates the document with normalized values and opens its detail with a confirmation', async () => {
    const api = createMockApi();
    const create = vi.spyOn(api.documents, 'create');
    await openCreate({ api });
    fillCreate({ Notas: ' Pendiente de copia ' });
    click('Crear documento');
    expect(
      await screen.findByRole('heading', { name: 'Tarjeta 2026', level: 1 }),
    ).toBeInTheDocument();
    expect(create).toHaveBeenCalledWith({
      ownerType: 'vehicle',
      ownerId: 'veh-001',
      typeCode: 'registration_card',
      title: 'Tarjeta 2026',
      notes: 'Pendiente de copia',
      issuedOn: '2026-01-10',
      expiresOn: '2027-01-10',
      documentNumber: 'TC-77',
    });
    expect(screen.getByText('Documento creado.')).toBeInTheDocument();
    await waitFor(() => expect(window.location.search).toBe(''));
    expect(window.location.pathname).toMatch(/^\/flota\/documentos\/doc-nuevo-/);
    expect(screen.getByText('TC-77')).toBeInTheDocument();
    expect(api.controls.documents()).toHaveLength(29);
  });

  it('puts an unavailable vehicle (422 invalid_owner) next to its field and focuses it', async () => {
    const api = createMockApi();
    await openCreate({ api });
    fillCreate();
    // The vehicle is archived by someone else after the list was loaded.
    await api.vehicles.archive('veh-001', 1);
    click('Crear documento');
    expect(
      await screen.findByText('El vehículo no existe o está archivado. Elige otro de la lista.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'El vehículo no es válido' })).toBeInTheDocument();
    await waitFor(() => expect(getField('Vehículo')).toHaveFocus());
    expect(getField('Vehículo')).toHaveAttribute('aria-invalid', 'true');
  });

  it('keeps what was typed and explains a failure of the server, and blocks a second submit while saving', async () => {
    const api = createMockApi();
    const real = api.documents.create;
    const gate = deferred();
    let calls = 0;
    api.documents.create = async (input) => {
      calls += 1;
      await gate.promise;
      return real(input);
    };
    await openCreate({ api });
    fillCreate();
    click('Crear documento');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cargando…' })).toBeDisabled());
    fireEvent.submit(screen.getByRole('form', { name: 'Nuevo documento' }));
    expect(calls).toBe(1);
    await act(async () => gate.resolve());
    await screen.findByText('Documento creado.');
  });

  it.each([
    [400, 'bad_request', 'El servidor rechazó los datos'],
    [403, 'forbidden', 'No tienes permiso'],
    [500, 'internal_error', 'No pudimos guardar el documento'],
  ] as const)('shows a %s failure without losing the form', async (status, code, title) => {
    const api = createMockApi();
    api.documents.create = async () => fail(status, code);
    await openCreate({ api });
    fillCreate();
    click('Crear documento');
    expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument();
    expect(getField('Título')).toHaveValue('Tarjeta 2026');
  });

  it('keeps the form and what was typed when the session expires, and saves after signing in again', async () => {
    const { api } = await openCreate();
    fillCreate();
    api.controls.expireSession();
    click('Crear documento');
    await screen.findByRole('group', { name: 'Sesión expirada' });
    expect(getField('Título')).toHaveValue('Tarjeta 2026');
    type('Cuenta de prueba', demoSubjects.admin);
    click('Continuar');
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: 'Sesión expirada' })).toBeNull(),
    );
    click('Crear documento');
    await screen.findByText('Documento creado.');
  });

  it('offers a retry when the vehicles cannot be loaded, and invites to register one when there are none', async () => {
    const api = createMockApi();
    api.controls.failNext('listVehicles');
    const failed = await renderApp({ api, path: '/flota/documentos/nuevo' });
    expect(
      await screen.findByRole('heading', { name: 'No pudimos cargar la información' }),
    ).toBeInTheDocument();
    click('Reintentar');
    await screen.findByRole('option', { name: /ECO-001/ });
    failed.unmount();
    await renderApp({ api: createMockApi({ vehicles: [] }), path: '/flota/documentos/nuevo' });
    expect(
      await screen.findByRole('heading', { name: 'Aún no hay vehículos' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Registrar un vehículo nuevo' })).toHaveAttribute(
      'href',
      '/flota/vehiculos/nuevo',
    );
  });

  it('cancels back to the list, and is closed to a role without create permission', async () => {
    const view = await openCreate();
    fireEvent.click(screen.getByRole('link', { name: 'Cancelar' }));
    await screen.findByRole('heading', { name: 'Documentos', level: 1 });
    expect(window.location.pathname).toBe('/flota/documentos');
    view.unmount();
    await renderApp({ account: 'mechanic', path: '/flota/documentos/nuevo' });
    expect(await screen.findByRole('heading', { name: 'No tienes acceso' })).toBeInTheDocument();
  });

  it('says when only part of the fleet is offered', async () => {
    const seed = Array.from({ length: 501 }, (_, index) => ({
      ...demoDocuments(1)[0]!,
      id: `x${index}`,
    }));
    expect(seed).toHaveLength(501);
    const { makeVehicle } = await import('../vehicles/fixtures');
    const vehicles = Array.from({ length: 501 }, (_, index) =>
      makeVehicle({
        id: `v${index}`,
        economicNumber: `E-${String(index).padStart(4, '0')}`,
        plate: `P-${index}`,
      }),
    );
    await renderApp({ api: createMockApi({ vehicles }), path: '/flota/documentos/nuevo' });
    expect(
      await screen.findByText('Se muestran los primeros vehículos del listado.'),
    ).toBeInTheDocument();
  });
});

describe('edit document', () => {
  const edit = (
    api = createMockApi(),
    id = 'doc-001',
    account: 'admin' | 'viewer' | 'dispatch' = 'admin',
  ) => renderApp({ api, account, path: `/flota/documentos/${id}/editar` });

  it('opens with the title and notes, shows what cannot change and explains how to correct a date', async () => {
    await edit();
    await screen.findByDisplayValue('Tarjeta de circulación 001');
    expect(screen.getByRole('heading', { name: 'Editar documento', level: 1 })).toBeInTheDocument();
    expect(screen.getByText(/Para corregir una fecha, renueva/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Fecha de vencimiento/)).toBeNull();
    expect(screen.queryByLabelText(/Tipo de documento/)).toBeNull();
    const form = screen.getByRole('form', { name: 'Editar documento' });
    expect(form).toHaveTextContent('Tarjeta de circulación');
    await waitFor(() => expect(form).toHaveTextContent('ECO-001'));
  });

  it('does not call the API when nothing changed', async () => {
    const api = createMockApi();
    const update = vi.spyOn(api.documents, 'update');
    await edit(api);
    await screen.findByDisplayValue('Tarjeta de circulación 001');
    click('Guardar cambios');
    expect(await screen.findByText('No hay cambios que guardar.')).toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
  });

  it('sends only the changed fields with the version it loaded and shows the result on the detail', async () => {
    const api = createMockApi();
    const update = vi.spyOn(api.documents, 'update');
    await edit(api);
    await screen.findByDisplayValue('Tarjeta de circulación 001');
    type('Título', '  Tarjeta   nueva ');
    type('Notas', 'Con sello');
    click('Guardar cambios');
    expect(await screen.findByText('Cambios guardados.')).toBeInTheDocument();
    expect(update).toHaveBeenCalledWith('doc-001', {
      version: 1,
      title: 'Tarjeta nueva',
      notes: 'Con sello',
    });
    expect(window.location.pathname).toBe('/flota/documentos/doc-001');
    expect(screen.getByRole('heading', { name: 'Tarjeta nueva', level: 1 })).toBeInTheDocument();
  });

  it('validates the title before sending', async () => {
    const api = createMockApi();
    const update = vi.spyOn(api.documents, 'update');
    await edit(api);
    await screen.findByDisplayValue('Tarjeta de circulación 001');
    type('Título', ' ');
    click('Guardar cambios');
    expect(screen.getByText('Escribe el título del documento.')).toBeInTheDocument();
    expect(getField('Título')).toHaveFocus();
    expect(update).not.toHaveBeenCalled();
  });

  it('tells the person someone else changed the document, and "Cargar datos actuales" starts over from the server', async () => {
    const { api } = await edit();
    await screen.findByDisplayValue('Tarjeta de circulación 001');
    api.controls.changeDocumentExternally('doc-001', { title: 'Cambiado por otra persona' });
    type('Título', 'Mi título');
    click('Guardar cambios');
    expect(
      await screen.findByRole('heading', { name: 'Otra persona modificó este documento' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Tus cambios no se guardaron/)).toBeInTheDocument();
    click('Cargar datos actuales');
    await waitFor(() => expect(getField('Título')).toHaveValue('Cambiado por otra persona'));
    expect(
      screen.queryByRole('heading', { name: 'Otra persona modificó este documento' }),
    ).toBeNull();
  });

  it('explains a document archived by someone else while editing (409 immutable)', async () => {
    const { api } = await edit();
    await screen.findByDisplayValue('Tarjeta de circulación 001');
    api.controls.archiveDocumentExternally('doc-001');
    type('Título', 'Otro');
    click('Guardar cambios');
    expect(
      await screen.findByRole('heading', { name: 'El documento ya no admite cambios' }),
    ).toBeInTheDocument();
  });

  it('shows archived documents as read-only instead of a form, and answers not found uniformly', async () => {
    const seed = [makeDocument({ archivedAt: '2026-09-30T10:00:00.000Z' })];
    const archived = await edit(createMockApi({ documents: seed }));
    expect(
      await screen.findByRole('heading', { name: 'Este documento no se puede cambiar' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Volver al documento' })).toHaveAttribute(
      'href',
      '/flota/documentos/doc-001',
    );
    expect(screen.queryByRole('form')).toBeNull();
    archived.unmount();
    const missing = await edit(createMockApi(), 'no-existe');
    expect(
      await screen.findByRole('heading', { name: 'Documento no encontrado' }),
    ).toBeInTheDocument();
    missing.unmount();
    const flaky = createMockApi();
    flaky.controls.failNext('getDocument');
    const failed = await edit(flaky);
    expect(
      await screen.findByRole('heading', { name: 'No pudimos cargar la información' }),
    ).toBeInTheDocument();
    click('Reintentar');
    await screen.findByDisplayValue('Tarjeta de circulación 001');
    failed.unmount();
    await edit(createMockApi(), 'doc-001', 'viewer');
    expect(await screen.findByRole('heading', { name: 'No tienes acceso' })).toBeInTheDocument();
  });

  it('keeps unsaved edits through an expired session when the document did not change meanwhile', async () => {
    const { api } = await edit();
    await screen.findByDisplayValue('Tarjeta de circulación 001');
    type('Título', 'Título pendiente');
    api.controls.expireSession();
    click('Guardar cambios');
    await screen.findByRole('group', { name: 'Sesión expirada' });
    type('Cuenta de prueba', demoSubjects.admin);
    click('Continuar');
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: 'Sesión expirada' })).toBeNull(),
    );
    await waitFor(() => expect(getField('Título')).toHaveValue('Título pendiente'));
    expect(screen.queryByText(/El documento cambió desde que empezaste/)).toBeNull();
    click('Guardar cambios');
    await screen.findByText('Cambios guardados.');
    expect(api.controls.documents()[0]?.title).toBe('Título pendiente');
  });

  it('does not restore edits over a newer version of the document: it loads the current data and says so', async () => {
    const { api } = await edit();
    await screen.findByDisplayValue('Tarjeta de circulación 001');
    type('Título', 'Título pendiente');
    api.controls.expireSession();
    click('Guardar cambios');
    await screen.findByRole('group', { name: 'Sesión expirada' });
    api.controls.changeDocumentExternally('doc-001', { title: 'Ajeno' });
    type('Cuenta de prueba', demoSubjects.admin);
    click('Continuar');
    expect(await screen.findByText(/El documento cambió desde que empezaste/)).toBeInTheDocument();
    expect(getField('Título')).toHaveValue('Ajeno');
  });
});

describe('renew document', () => {
  const renew = (api = createMockApi(), id = 'doc-001', account: 'admin' | 'viewer' = 'admin') =>
    renderApp({ api, account, path: `/flota/documentos/${id}/renovar` });

  it('opens with the number carried over, explains that the old revision stays and asks for the new dates', async () => {
    await renew();
    await screen.findByRole('heading', { name: 'Renovar documento', level: 1 });
    expect(await screen.findByDisplayValue('DOC-0001')).toBeInTheDocument();
    expect(
      screen.getByText(/La anterior queda en el historial como reemplazada/),
    ).toBeInTheDocument();
    expect(getField('Fecha de vencimiento')).toHaveValue('');
    expect(getField('Fecha de vencimiento')).toBeRequired();
    expect(screen.queryByLabelText(/Título/)).toBeNull();
    click('Renovar documento');
    expect(getField('Fecha de vencimiento')).toHaveAccessibleDescription(
      'Escribe el vencimiento: este tipo de documento siempre vence.',
    );
    expect(getField('Fecha de vencimiento')).toHaveFocus();
  });

  it('renews with the new validity, appends a revision and shows the replaced one in the history', async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api.documents, 'renew');
    await renew(api);
    await screen.findByDisplayValue('DOC-0001');
    type('Fecha de emisión', '2026-10-01');
    type('Fecha de vencimiento', '2028-10-01');
    click('Renovar documento');
    expect(
      await screen.findByText('Documento renovado. La revisión anterior quedó en el historial.'),
    ).toBeInTheDocument();
    expect(spy).toHaveBeenCalledWith('doc-001', {
      version: 1,
      issuedOn: '2026-10-01',
      expiresOn: '2028-10-01',
      documentNumber: 'DOC-0001',
    });
    expect(await screen.findByText('Revisión 2 · Vigente')).toBeInTheDocument();
    expect(screen.getByText('Revisión 1 · Reemplazado')).toBeInTheDocument();
  });

  it('refuses an expiry before the issue date without calling the API', async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api.documents, 'renew');
    await renew(api);
    await screen.findByDisplayValue('DOC-0001');
    type('Fecha de emisión', '2026-10-01');
    type('Fecha de vencimiento', '2026-09-01');
    click('Renovar documento');
    expect(
      screen.getByText('El vencimiento no puede ser anterior a la emisión.'),
    ).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  it('tells the person someone else changed the document, and archived documents cannot be renewed', async () => {
    const { api } = await renew();
    await screen.findByDisplayValue('DOC-0001');
    api.controls.changeDocumentExternally('doc-001', { title: 'Otro' });
    type('Fecha de vencimiento', '2028-10-01');
    click('Renovar documento');
    expect(
      await screen.findByRole('heading', { name: 'Otra persona modificó este documento' }),
    ).toBeInTheDocument();
    click('Cargar datos actuales');
    await waitFor(() => expect(getField('Fecha de vencimiento')).toHaveValue(''));
    api.controls.archiveDocumentExternally('doc-001');
    type('Fecha de vencimiento', '2028-10-01');
    click('Renovar documento');
    expect(
      await screen.findByRole('heading', { name: 'El documento ya no admite cambios' }),
    ).toBeInTheDocument();
  });

  it('explains a vehicle that was archived since (422 invalid_owner) and is closed to a viewer', async () => {
    const { api } = await renew();
    await screen.findByDisplayValue('DOC-0001');
    await api.vehicles.archive('veh-001', 1);
    type('Fecha de vencimiento', '2028-10-01');
    click('Renovar documento');
    expect(
      await screen.findByText(/ya no existe o está archivado, por lo que no se puede renovar/),
    ).toBeInTheDocument();
  });

  it('shows the owner name of the document being renewed and falls back when the vehicle cannot be read', async () => {
    const { api } = await renew();
    const form = await screen.findByRole('form', { name: 'Renovar documento' });
    await waitFor(() => expect(form).toHaveTextContent('ECO-001'));
    expect(api).toBeDefined();
  });

  it('is closed to a viewer', async () => {
    await renew(createMockApi(), 'doc-001', 'viewer');
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
    expect(of(409, 'immutable').alert?.title).toBe('El documento ya no admite cambios');
    expect(of(422, 'invalid_owner', 'create').alert?.message).toMatch(/Elige otro vehículo/);
    expect(of(422, 'invalid_owner', 'renew').alert?.message).toMatch(/no se puede renovar/);
    expect(of(422, 'invalid_owner', 'renew').fields).toEqual({});
    expect(of(400, 'bad_request').alert?.title).toBe('El servidor rechazó los datos');
    expect(of(403, 'forbidden', 'renew').alert?.message).toMatch(/renovar documentos/);
    expect(of(403, 'forbidden').alert?.message).toMatch(/guardar documentos/);
    expect(of(404, 'not_found').alert?.title).toBe('El documento ya no existe');
    expect(of(500, 'network_error', 'renew').alert?.title).toBe('No pudimos renovar el documento');
  });
});
