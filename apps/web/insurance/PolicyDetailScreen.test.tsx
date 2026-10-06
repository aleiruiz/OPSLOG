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
import type { InsurancePolicy, Result } from '../app/types';
import { demoPolicies, makePolicy } from './fixtures';

const open = (id = 'pol-001', options: Parameters<typeof renderApp>[0] = {}) =>
  renderApp({ path: `/flota/seguros/${id}`, ...options });
const title = /^Póliza POL-/;

async function openArchiveDialog() {
  await screen.findByRole('heading', { name: title, level: 1 });
  const trigger = screen.getByRole('button', { name: 'Archivar' });
  trigger.focus();
  fireEvent.click(trigger);
  const dialog = await screen.findByRole('dialog');
  return { trigger, dialog };
}

const failing = (api: MockApi, status: number, code: string) => {
  api.insurance.archive = async (): Promise<Result<InsurancePolicy>> => ({
    ok: false,
    error: { code, status: status as 409, message: 'x', correlationId: 'c' },
  });
};

describe('policy detail', () => {
  it('shows every field with Spanish labels, the status with its days, the vehicle and the history', async () => {
    await open('pol-002');
    expect(
      await screen.findByRole('heading', { name: 'Póliza POL-2026-0002', level: 1 }),
    ).toBeInTheDocument();
    const data = screen.getByText('Aseguradora').closest('dl') as HTMLElement;
    expect(data).toHaveTextContent('Seguros Demo Centro');
    expect(data).toHaveTextContent('POL-2026-0002');
    expect(data).toHaveTextContent('Daños a terceros');
    expect(data).toHaveTextContent('Vencida');
    expect(data).toHaveTextContent('Venció hace 3 días');
    expect(data).toHaveTextContent('Revisión2');
    expect(data).not.toHaveTextContent(/third_party|expired/);
    expect(await screen.findByRole('link', { name: 'ECO-003' })).toHaveAttribute(
      'href',
      '/flota/vehiculos/veh-003',
    );
    expect(screen.getByRole('link', { name: 'Volver a seguros' })).toHaveAttribute(
      'href',
      '/flota/seguros',
    );
    const history = screen
      .getByRole('heading', { name: 'Historial de revisiones' })
      .closest('section')!;
    const items = within(history).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Revisión 2 · Vencida');
    expect(items[1]).toHaveTextContent('Revisión 1 · Reemplazada');
    expect(items[1]).toHaveTextContent(
      /Póliza POL-2026-0002 · Daños a terceros · .* – .* · Deducible: .* · Por user-admin/,
    );
  });

  it('shows the deductible to a role with view_costs: an exact amount, a percentage or none', async () => {
    const view = await open('pol-002');
    const amount = await screen.findByText('12,500.00 MXN', { selector: 'dd' });
    expect(amount).toBeInTheDocument();
    expect(await screen.findAllByText(/Deducible: 12,500.00 MXN/)).toHaveLength(2);
    view.unmount();
    const percent = await open('pol-003');
    expect(await screen.findByText('15 %', { selector: 'dd' })).toBeInTheDocument();
    percent.unmount();
    await open('pol-001');
    expect(await screen.findByText('Sin deducible', { selector: 'dd' })).toBeInTheDocument();
  });

  it('never shows the amount to a role without view_costs, and says there is one', async () => {
    await open('pol-002', { account: 'dispatch' });
    await screen.findByRole('heading', { name: 'Póliza POL-2026-0002', level: 1 });
    expect(
      screen.getByText('Registrado. Solo lo ve quien tiene permiso para ver costos.', {
        selector: 'dd',
      }),
    ).toBeInTheDocument();
    const history = await screen.findByRole('heading', { name: 'Historial de revisiones' });
    expect(history.closest('section')).toHaveTextContent('Deducible: Registrado.');
    expect(document.body).not.toHaveTextContent(/12,500|1250000/);
  });

  it('shows a policy that has not started as such, with the notes and no deductible', async () => {
    const seed = [
      makePolicy({
        status: 'valid',
        covering: false,
        startsOn: '2026-10-20',
        endsOn: '2027-10-19',
        daysToExpiry: 378,
        coverageNotes: 'Incluye cristales',
      }),
    ];
    await open('pol-001', { api: createMockApi({ policies: seed }) });
    await screen.findByRole('heading', { name: title, level: 1 });
    const data = screen.getByText('Aseguradora').closest('dl') as HTMLElement;
    expect(data).toHaveTextContent('Aún no inicia');
    expect(data).toHaveTextContent('Incluye cristales');
    expect(data).toHaveTextContent('Sin deducible');
  });

  it('shows renew, edit and archive to an administrator, renew and edit to a dispatcher and nothing to a viewer', async () => {
    const admin = await open();
    await screen.findByRole('heading', { name: title, level: 1 });
    expect(screen.getByRole('link', { name: 'Renovar' })).toHaveAttribute(
      'href',
      '/flota/seguros/pol-001/renovar',
    );
    expect(screen.getByRole('link', { name: 'Editar' })).toHaveAttribute(
      'href',
      '/flota/seguros/pol-001/editar',
    );
    expect(screen.getByRole('button', { name: 'Archivar' })).toBeInTheDocument();
    admin.unmount();
    const dispatch = await open('pol-001', { account: 'dispatch' });
    await screen.findByRole('heading', { name: title, level: 1 });
    expect(screen.getByRole('link', { name: 'Renovar' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archivar' })).toBeNull();
    dispatch.unmount();
    await open('pol-001', { account: 'viewer' });
    await screen.findByRole('heading', { name: title, level: 1 });
    expect(screen.queryByRole('link', { name: 'Renovar' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Editar' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Archivar' })).toBeNull();
  });

  it('explains an archived policy instead of offering changes, and keeps its history', async () => {
    const seed = [makePolicy({ archivedAt: '2026-09-30T10:00:00.000Z', version: 3 })];
    await open('pol-001', { api: createMockApi({ policies: seed }) });
    expect(await screen.findByRole('heading', { name: 'Póliza archivada' })).toBeInTheDocument();
    expect(screen.getByText(/no se puede restaurar desde la aplicación/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Renovar' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Archivar' })).toBeNull();
    expect(await screen.findByText(/Revisión 1/)).toBeInTheDocument();
  });

  it('answers the same message for an unknown policy, and offers a retry for other errors', async () => {
    const missing = await open('no-existe');
    expect(
      await screen.findByRole('heading', { name: 'Póliza no encontrada' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Volver a seguros' })).toBeInTheDocument();
    missing.unmount();
    const api = createMockApi();
    api.controls.failNext('getPolicy');
    await open('pol-001', { api });
    expect(
      await screen.findByRole('heading', { name: 'No pudimos cargar la información' }),
    ).toBeInTheDocument();
    click('Reintentar');
    await screen.findByRole('heading', { name: title, level: 1 });
  });

  it('shows the result of the previous screen once and removes it from the address bar', async () => {
    for (const [code, text] of [
      ['creada', 'Póliza creada.'],
      ['guardada', 'Cambios guardados.'],
      ['renovada', 'Póliza renovada. La revisión anterior quedó en el historial.'],
    ] as const) {
      const view = await renderApp({ path: `/flota/seguros/pol-001?aviso=${code}` });
      expect(await screen.findByText(text)).toBeInTheDocument();
      await waitFor(() => expect(window.location.search).toBe(''));
      view.unmount();
    }
  });

  it('ignores unknown notice codes, including names of the object prototype', async () => {
    for (const code of ['otro', 'constructor']) {
      const view = await renderApp({ path: `/flota/seguros/pol-001?aviso=${code}` });
      await screen.findByRole('heading', { name: title, level: 1 });
      expect(screen.queryByRole('region', { name: 'Notificaciones' })).toBeNull();
      view.unmount();
    }
  });
});

describe('policy history', () => {
  const seed = [makePolicy({ revision: 30 })];

  it('loads further pages and keeps them, and reports a failure without losing what is shown', async () => {
    const { api } = await open('pol-001', { api: createMockApi({ policies: seed }) });
    const spy = vi.spyOn(api.insurance, 'history');
    await screen.findByText('Revisión 30 · Vigente');
    const section = screen
      .getByRole('heading', { name: 'Historial de revisiones' })
      .closest('section')!;
    expect(within(section).getAllByRole('listitem')).toHaveLength(25);
    api.controls.failNext('policyHistory');
    click('Cargar más historial');
    expect(await screen.findByText('No pudimos cargar más historial.')).toBeInTheDocument();
    expect(within(section).getAllByRole('listitem')).toHaveLength(25);
    click('Cargar más historial');
    await waitFor(() => expect(within(section).getAllByRole('listitem')).toHaveLength(30));
    expect(spy).toHaveBeenLastCalledWith('pol-001', { limit: 25, cursor: 'mock:25' });
    expect(screen.queryByRole('button', { name: 'Cargar más historial' })).toBeNull();
  });

  it('expires the session on a 401 while loading more', async () => {
    const { api } = await open('pol-001', { api: createMockApi({ policies: seed }) });
    await screen.findByText('Revisión 30 · Vigente');
    api.controls.failNext('policyHistory', 401);
    click('Cargar más historial');
    await screen.findByRole('group', { name: 'Sesión expirada' });
  });

  it('ignores a page that arrives after the history was reloaded', async () => {
    const api = createMockApi({ policies: seed });
    const real = api.insurance.history;
    const gate = deferred();
    await open('pol-001', { api });
    await screen.findByText('Revisión 30 · Vigente');
    api.insurance.history = async (id, query) => {
      if (query?.cursor) await gate.promise;
      return real(id, query);
    };
    click('Cargar más historial');
    fireEvent.click(screen.getByRole('button', { name: 'Archivar' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Archivar póliza' }));
    await screen.findByText('Póliza archivada.');
    await act(async () => gate.resolve());
    await new Promise((resolve) => setTimeout(resolve, 20));
    const section = screen
      .getByRole('heading', { name: 'Historial de revisiones' })
      .closest('section')!;
    expect(within(section).getAllByRole('listitem')).toHaveLength(25);
  });

  it('offers a retry when the history cannot be read', async () => {
    const api = createMockApi();
    api.controls.failNext('policyHistory');
    await open('pol-001', { api });
    await screen.findByRole('heading', { name: title, level: 1 });
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
    expect(dialog).toHaveAccessibleName('Archivar la póliza POL-2026-0001');
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
    const spy = vi.spyOn(api.insurance, 'archive');
    const { dialog } = await openArchiveDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archivar póliza' }));
    expect(await screen.findByText('Póliza archivada.')).toBeInTheDocument();
    expect(spy).toHaveBeenCalledWith('pol-001', 1);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('heading', { name: 'Póliza archivada' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archivar' })).toBeNull();
    expect(api.controls.policies()[0]?.archivedAt).not.toBeNull();
  });

  it('cancels without archiving, and blocks both actions while archiving', async () => {
    const api = createMockApi({ policies: demoPolicies(2) });
    const real = api.insurance.archive;
    const gate = deferred();
    api.insurance.archive = async (id, version) => {
      await gate.promise;
      return real(id, version);
    };
    await open('pol-001', { api });
    const first = await openArchiveDialog();
    fireEvent.click(within(first.dialog).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.controls.policies()[0]?.archivedAt).toBeNull();
    const second = await openArchiveDialog();
    fireEvent.click(within(second.dialog).getByRole('button', { name: 'Archivar póliza' }));
    await waitFor(() =>
      expect(within(second.dialog).getByRole('button', { name: 'Cancelar' })).toBeDisabled(),
    );
    fireEvent.keyDown(second.dialog, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await act(async () => gate.resolve());
    await screen.findByText('Póliza archivada.');
  });

  it('keeps the dialog open with a recoverable message when someone else changed the policy', async () => {
    const { api } = await open();
    await screen.findByRole('heading', { name: title, level: 1 });
    api.controls.changePolicyExternally('pol-001', { insurer: 'Aseguradora Nueva' });
    const { dialog } = await openArchiveDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archivar póliza' }));
    expect(
      await within(dialog).findByText(/Otra persona modificó esta póliza/),
    ).toBeInTheDocument();
    expect(api.controls.policies()[0]?.archivedAt).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Recargar datos' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText('Aseguradora Nueva', { selector: 'dd' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Archivar' }));
    const second = await screen.findByRole('dialog');
    fireEvent.click(within(second).getByRole('button', { name: 'Archivar póliza' }));
    expect(await screen.findByText('Póliza archivada.')).toBeInTheDocument();
  });

  it.each([
    ['immutable', 409, /ya estaba archivada/, 'Recargar datos'],
    ['forbidden', 403, /No tienes permiso para archivar/, null],
    ['not_found', 404, /ya no existe/, null],
    ['internal_error', 500, /No pudimos archivar la póliza/, null],
  ] as const)('explains a %s answer inside the dialog', async (code, status, message, action) => {
    const api = createMockApi();
    failing(api, status, code);
    await open('pol-001', { api });
    const { dialog } = await openArchiveDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archivar póliza' }));
    expect(await within(dialog).findByText(message)).toBeInTheDocument();
    if (action) expect(within(dialog).getByRole('button', { name: action })).toBeInTheDocument();
    else expect(within(dialog).queryByRole('button', { name: 'Recargar datos' })).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Archivar póliza' })).toBeEnabled();
  });

  it('closes the dialog and shows the expired-session panel on a 401', async () => {
    const { api } = await open();
    const { dialog } = await openArchiveDialog();
    api.controls.expireSession();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archivar póliza' }));
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
