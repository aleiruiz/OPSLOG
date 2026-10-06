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
import type { Document, Result } from '../app/types';
import { demoDocuments, makeDocument } from './fixtures';

const open = (id = 'doc-001', options: Parameters<typeof renderApp>[0] = {}) =>
  renderApp({ path: `/flota/documentos/${id}`, ...options });

async function openArchiveDialog() {
  await screen.findByRole('heading', { name: /^Tarjeta/, level: 1 });
  const trigger = screen.getByRole('button', { name: 'Archivar' });
  trigger.focus();
  fireEvent.click(trigger);
  const dialog = await screen.findByRole('dialog');
  return { trigger, dialog };
}

const failing = (api: MockApi, status: number, code: string) => {
  api.documents.archive = async (): Promise<Result<Document>> => ({
    ok: false,
    error: { code, status: status as 409, message: 'x', correlationId: 'c' },
  });
};

describe('document detail', () => {
  it('shows every field with Spanish labels, the status with its days, the owner and the history', async () => {
    await open('doc-002');
    expect(
      await screen.findByRole('heading', { name: 'Verificación técnica 002', level: 1 }),
    ).toBeInTheDocument();
    const data = screen.getByText('Título').closest('dl') as HTMLElement;
    expect(data).toHaveTextContent('Verificación técnica');
    expect(data).toHaveTextContent('DOC-0002');
    expect(data).toHaveTextContent('Vencido');
    expect(data).toHaveTextContent('Venció hace 3 días');
    expect(data).toHaveTextContent('Revisión2');
    expect(data).not.toHaveTextContent(/technical_inspection|expired/);
    expect(await screen.findByRole('link', { name: 'ECO-004' })).toHaveAttribute(
      'href',
      '/flota/vehiculos/veh-004',
    );
    expect(screen.getByRole('link', { name: 'Volver a documentos' })).toHaveAttribute(
      'href',
      '/flota/documentos',
    );
    // History: current revision first, the earlier one replaced.
    const history = screen
      .getByRole('heading', { name: 'Historial de revisiones' })
      .closest('section')!;
    const items = within(history).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Revisión 2 · Vencido');
    expect(items[1]).toHaveTextContent('Revisión 1 · Reemplazado');
    expect(items[1]).toHaveTextContent(
      /Emitido el .* · vence el .* · número DOC-0002 · Por user-admin/,
    );
  });

  it('shows an employee document, a document without expiry or number and the notes', async () => {
    const seed = [
      makeDocument({
        id: 'emp',
        ownerType: 'employee',
        ownerId: 'emp-001',
        typeCode: 'training_certificate',
        title: 'Constancia de curso',
        expiresOn: null,
        daysToExpiry: null,
        issuedOn: null,
        documentNumber: null,
        notes: 'Entregada en físico',
      }),
    ];
    await open('emp', { api: createMockApi({ documents: seed }) });
    await screen.findByRole('heading', { name: 'Constancia de curso', level: 1 });
    const data = screen.getByText('Título').closest('dl') as HTMLElement;
    expect(data).toHaveTextContent('Empleado');
    expect(data).toHaveTextContent('Sin vencimiento');
    expect(data).toHaveTextContent('Entregada en físico');
    expect(data).toHaveTextContent('Constancia de capacitación');
    expect(
      screen.getByRole('heading', { name: 'Historial de revisiones' }).closest('section'),
    ).toHaveTextContent('Sin fecha de emisión · sin vencimiento');
  });

  it('shows renew, edit and archive to an administrator, renew and edit to a dispatcher and nothing to a viewer', async () => {
    const admin = await open();
    await screen.findByRole('heading', { name: /^Tarjeta/, level: 1 });
    expect(screen.getByRole('link', { name: 'Renovar' })).toHaveAttribute(
      'href',
      '/flota/documentos/doc-001/renovar',
    );
    expect(screen.getByRole('link', { name: 'Editar' })).toHaveAttribute(
      'href',
      '/flota/documentos/doc-001/editar',
    );
    expect(screen.getByRole('button', { name: 'Archivar' })).toBeInTheDocument();
    admin.unmount();
    const dispatch = await open('doc-001', { account: 'dispatch' });
    await screen.findByRole('heading', { name: /^Tarjeta/, level: 1 });
    expect(screen.getByRole('link', { name: 'Renovar' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archivar' })).toBeNull();
    dispatch.unmount();
    await open('doc-001', { account: 'viewer' });
    await screen.findByRole('heading', { name: /^Tarjeta/, level: 1 });
    expect(screen.queryByRole('link', { name: 'Renovar' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Editar' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Archivar' })).toBeNull();
  });

  it('explains an archived document instead of offering changes, and keeps its history', async () => {
    const seed = [makeDocument({ archivedAt: '2026-09-30T10:00:00.000Z', version: 3 })];
    await open('doc-001', { api: createMockApi({ documents: seed }) });
    expect(await screen.findByRole('heading', { name: 'Documento archivado' })).toBeInTheDocument();
    expect(screen.getByText(/no se puede restaurar desde la aplicación/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Renovar' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Archivar' })).toBeNull();
    expect(await screen.findByText(/Revisión 1/)).toBeInTheDocument();
  });

  it('answers the same message for an unknown document, and offers a retry for other errors', async () => {
    const missing = await open('no-existe');
    expect(
      await screen.findByRole('heading', { name: 'Documento no encontrado' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Volver a documentos' })).toBeInTheDocument();
    missing.unmount();
    const api = createMockApi();
    api.controls.failNext('getDocument');
    await open('doc-001', { api });
    expect(
      await screen.findByRole('heading', { name: 'No pudimos cargar la información' }),
    ).toBeInTheDocument();
    click('Reintentar');
    await screen.findByRole('heading', { name: /^Tarjeta/, level: 1 });
  });

  it('shows the result of the previous screen once and removes it from the address bar', async () => {
    for (const [code, text] of [
      ['creado', 'Documento creado.'],
      ['guardado', 'Cambios guardados.'],
      ['renovado', 'Documento renovado. La revisión anterior quedó en el historial.'],
    ] as const) {
      const view = await renderApp({ path: `/flota/documentos/doc-001?aviso=${code}` });
      expect(await screen.findByText(text)).toBeInTheDocument();
      await waitFor(() => expect(window.location.search).toBe(''));
      view.unmount();
    }
  });

  it('ignores unknown notice codes, including names of the object prototype', async () => {
    for (const code of ['otro', 'constructor']) {
      const view = await renderApp({ path: `/flota/documentos/doc-001?aviso=${code}` });
      await screen.findByRole('heading', { name: /^Tarjeta/, level: 1 });
      expect(screen.queryByRole('region', { name: 'Notificaciones' })).toBeNull();
      view.unmount();
    }
  });
});

describe('document history', () => {
  const seed = [makeDocument({ revision: 30 })];

  it('loads further pages and keeps them, and reports a failure without losing what is shown', async () => {
    const { api } = await open('doc-001', { api: createMockApi({ documents: seed }) });
    const spy = vi.spyOn(api.documents, 'history');
    await screen.findByText('Revisión 30 · Vigente');
    const section = screen
      .getByRole('heading', { name: 'Historial de revisiones' })
      .closest('section')!;
    expect(within(section).getAllByRole('listitem')).toHaveLength(25);
    api.controls.failNext('documentHistory');
    click('Cargar más historial');
    expect(await screen.findByText('No pudimos cargar más historial.')).toBeInTheDocument();
    expect(within(section).getAllByRole('listitem')).toHaveLength(25);
    click('Cargar más historial');
    await waitFor(() => expect(within(section).getAllByRole('listitem')).toHaveLength(30));
    expect(spy).toHaveBeenLastCalledWith('doc-001', { limit: 25, cursor: 'mock:25' });
    expect(screen.queryByRole('button', { name: 'Cargar más historial' })).toBeNull();
  });

  it('expires the session on a 401 while loading more', async () => {
    const { api } = await open('doc-001', { api: createMockApi({ documents: seed }) });
    await screen.findByText('Revisión 30 · Vigente');
    api.controls.failNext('documentHistory', 401);
    click('Cargar más historial');
    await screen.findByRole('group', { name: 'Sesión expirada' }, { timeout: 5000 });
  });

  it('ignores a page that arrives after the history was reloaded', async () => {
    const api = createMockApi({ documents: seed });
    const real = api.documents.history;
    const gate = deferred();
    await open('doc-001', { api });
    await screen.findByText('Revisión 30 · Vigente');
    api.documents.history = async (id, query) => {
      if (query?.cursor) await gate.promise;
      return real(id, query);
    };
    click('Cargar más historial');
    // Archiving reloads the history while the second page is still in flight.
    fireEvent.click(screen.getByRole('button', { name: 'Archivar' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Archivar documento' }));
    await screen.findByText('Documento archivado.');
    await act(async () => gate.resolve());
    await new Promise((resolve) => setTimeout(resolve, 20));
    const section = screen
      .getByRole('heading', { name: 'Historial de revisiones' })
      .closest('section')!;
    expect(within(section).getAllByRole('listitem')).toHaveLength(25);
  });

  it('offers a retry when the history cannot be read', async () => {
    const api = createMockApi();
    api.controls.failNext('documentHistory');
    await open('doc-001', { api });
    await screen.findByRole('heading', { name: /^Tarjeta/, level: 1 });
    const section = screen
      .getByRole('heading', { name: 'Historial de revisiones' })
      .closest('section')!;
    expect(await within(section).findByRole('button', { name: 'Reintentar' })).toBeInTheDocument();
    fireEvent.click(within(section).getByRole('button', { name: 'Reintentar' }));
    expect(await within(section).findByText(/Revisión 1/)).toBeInTheDocument();
  });
});

describe('archive confirmation', () => {
  it('opens a labelled modal with focus on the safe choice, and Escape closes it and restores focus', async () => {
    await open();
    const { trigger, dialog } = await openArchiveDialog();
    expect(dialog).toHaveAccessibleName(/^Archivar el documento Tarjeta/);
    expect(dialog).toHaveAccessibleDescription(/no se podrá editar ni renovar/);
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Cancelar' })).toHaveFocus(),
    );
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('archives with the version it read, shows the archived state and keeps the history', async () => {
    const { api } = await open();
    const spy = vi.spyOn(api.documents, 'archive');
    const { dialog } = await openArchiveDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archivar documento' }));
    expect(await screen.findByText('Documento archivado.')).toBeInTheDocument();
    expect(spy).toHaveBeenCalledWith('doc-001', 1);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('heading', { name: 'Documento archivado' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archivar' })).toBeNull();
    expect(api.controls.documents()[0]?.archivedAt).not.toBeNull();
  });

  it('cancels without archiving, and blocks both actions while archiving', async () => {
    const api = createMockApi({ documents: demoDocuments(2) });
    const real = api.documents.archive;
    const gate = deferred();
    api.documents.archive = async (id, version) => {
      await gate.promise;
      return real(id, version);
    };
    await open('doc-001', { api });
    const first = await openArchiveDialog();
    fireEvent.click(within(first.dialog).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.controls.documents()[0]?.archivedAt).toBeNull();
    const second = await openArchiveDialog();
    fireEvent.click(within(second.dialog).getByRole('button', { name: 'Archivar documento' }));
    await waitFor(() =>
      expect(within(second.dialog).getByRole('button', { name: 'Cancelar' })).toBeDisabled(),
    );
    fireEvent.keyDown(second.dialog, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await act(async () => gate.resolve());
    await screen.findByText('Documento archivado.');
  });

  it('keeps the dialog open with a recoverable message when someone else changed the document', async () => {
    const { api } = await open();
    await screen.findByRole('heading', { name: /^Tarjeta/, level: 1 });
    api.controls.changeDocumentExternally('doc-001', { title: 'Título nuevo' });
    const { dialog } = await openArchiveDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archivar documento' }));
    expect(
      await within(dialog).findByText(/Otra persona modificó este documento/),
    ).toBeInTheDocument();
    expect(api.controls.documents()[0]?.archivedAt).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Recargar datos' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(
      await screen.findByRole('heading', { name: 'Título nuevo', level: 1 }),
    ).toBeInTheDocument();
    const second = await (async () => {
      const trigger = screen.getByRole('button', { name: 'Archivar' });
      fireEvent.click(trigger);
      return screen.findByRole('dialog');
    })();
    fireEvent.click(within(second).getByRole('button', { name: 'Archivar documento' }));
    expect(await screen.findByText('Documento archivado.')).toBeInTheDocument();
  });

  it.each([
    ['immutable', 409, /ya estaba archivado/, 'Recargar datos'],
    ['forbidden', 403, /No tienes permiso para archivar/, null],
    ['not_found', 404, /ya no existe/, null],
    ['internal_error', 500, /No pudimos archivar el documento/, null],
  ] as const)('explains a %s answer inside the dialog', async (code, status, message, action) => {
    const api = createMockApi();
    failing(api, status, code);
    await open('doc-001', { api });
    const { dialog } = await openArchiveDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archivar documento' }));
    expect(await within(dialog).findByText(message)).toBeInTheDocument();
    if (action) expect(within(dialog).getByRole('button', { name: action })).toBeInTheDocument();
    else expect(within(dialog).queryByRole('button', { name: 'Recargar datos' })).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Archivar documento' })).toBeEnabled();
  });

  it('closes the dialog and shows the expired-session panel on a 401', async () => {
    const { api } = await open();
    const { dialog } = await openArchiveDialog();
    api.controls.expireSession();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archivar documento' }));
    await screen.findByRole('group', { name: 'Sesión expirada' });
    expect(screen.queryByRole('dialog')).toBeNull();
    type('Cuenta de prueba', demoSubjects.admin);
    click('Continuar');
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: 'Sesión expirada' })).toBeNull(),
    );
    expect(await screen.findByRole('button', { name: 'Archivar' })).toBeInTheDocument();
  });
});
