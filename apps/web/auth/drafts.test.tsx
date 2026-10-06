import { act } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi, demoCredentials } from '../app/mockApi';
import { deferred, fireEvent, renderWithSession, screen } from '../app/test/utils';
import { DraftNotice, draftSaveDelayMs, useServerDraft } from './drafts';
import { useSession } from './session';

function Probe({ scope = 'probe' }: { scope?: string }) {
  const draft = useServerDraft(scope, { note: '' });
  const { logout, login, state } = useSession();
  return (
    <div>
      <input
        aria-label="Nota"
        value={draft.values.note}
        onChange={(e) => draft.setField('note', e.target.value)}
      />
      <DraftNotice status={draft.status} />
      <span data-testid="session">{state.status}</span>
      <button onClick={() => void draft.discard()}>Descartar</button>
      <button onClick={() => void draft.saveNow()}>Guardar ahora</button>
      <button onClick={() => void logout()}>Salir</button>
      <button onClick={() => void login(demoCredentials.admin)}>Entrar</button>
    </div>
  );
}

const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const note = () => screen.getByLabelText('Nota');

describe('useServerDraft', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: false }));
  afterEach(() => vi.useRealTimers());

  async function mount(options: Parameters<typeof renderWithSession>[1] = {}) {
    const view = await act(async () => renderWithSession(<Probe />, options));
    await advance(10);
    return view;
  }

  it('debounces edits and saves them to the server, not to browser storage', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const api = createMockApi();
    const save = vi.spyOn(api.drafts, 'save');
    await mount({ api });
    fireEvent.change(note(), { target: { value: 'a' } });
    fireEvent.change(note(), { target: { value: 'ab' } });
    await advance(draftSaveDelayMs - 1);
    expect(save).not.toHaveBeenCalled();
    await advance(5);
    expect(save).toHaveBeenCalledTimes(1);
    expect(api.controls.storedDrafts()).toEqual({ probe: { note: 'ab' } });
    expect(screen.getByText('Borrador guardado.')).toBeInTheDocument();
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
  });

  it('restores a draft previously saved on the server', async () => {
    const api = createMockApi();
    await api.auth.login(demoCredentials.admin);
    await api.drafts.save('probe', { note: 'guardada antes' });
    await mount({ api });
    expect(note()).toHaveValue('guardada antes');
    expect(screen.getByText('Recuperamos tu borrador guardado.')).toBeInTheDocument();
  });

  it('does not overwrite what the person typed with a draft that arrives late', async () => {
    const api = createMockApi();
    await api.auth.login(demoCredentials.admin);
    await api.drafts.save('probe', { note: 'del servidor' });
    const realLoad = api.drafts.load;
    const gate = deferred();
    api.drafts.load = async (scope) => {
      await gate.promise;
      return realLoad(scope);
    };
    await mount({ api });
    fireEvent.change(note(), { target: { value: 'escrito ahora' } });
    await act(async () => gate.resolve());
    await advance(10);
    expect(note()).toHaveValue('escrito ahora');
  });

  it('keeps unsent edits in memory when the session expired and sends them after signing in again', async () => {
    const api = createMockApi();
    await mount({ api });
    fireEvent.change(note(), { target: { value: 'v1' } });
    await advance(draftSaveDelayMs + 10);
    expect(api.controls.storedDrafts()).toEqual({ probe: { note: 'v1' } });

    api.controls.expireSession();
    fireEvent.change(note(), { target: { value: 'v2' } });
    await advance(draftSaveDelayMs + 10);
    expect(
      screen.getByText(/Tu sesión expiró\. Mantenemos estos cambios en esta pantalla/),
    ).toBeInTheDocument();
    expect(note()).toHaveValue('v2');

    await api.auth.login(demoCredentials.admin);
    fireEvent.click(screen.getByRole('button', { name: 'Entrar' }));
    await advance(50);
    expect(api.controls.storedDrafts()).toEqual({ probe: { note: 'v2' } });
    expect(screen.getByText('Borrador guardado.')).toBeInTheDocument();
  });

  it('marks the session as expired when a save answers 401', async () => {
    const api = createMockApi();
    await mount({ api });
    api.controls.expireSession();
    fireEvent.change(note(), { target: { value: 'x' } });
    await advance(draftSaveDelayMs + 10);
    expect(screen.getByText(/Tu sesión expiró/)).toBeInTheDocument();
  });

  it('reports a recoverable save error and retries on the next edit', async () => {
    const api = createMockApi();
    await mount({ api });
    api.controls.failNext('saveDraft');
    fireEvent.change(note(), { target: { value: 'x' } });
    await advance(draftSaveDelayMs + 10);
    expect(screen.getByText(/No pudimos guardar el borrador/)).toBeInTheDocument();
    fireEvent.change(note(), { target: { value: 'xy' } });
    await advance(draftSaveDelayMs + 10);
    expect(api.controls.storedDrafts()).toEqual({ probe: { note: 'xy' } });
  });

  it('can save immediately and discard the server draft', async () => {
    const api = createMockApi();
    await mount({ api });
    fireEvent.change(note(), { target: { value: 'ya' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar ahora' }));
    await advance(10);
    expect(api.controls.storedDrafts()).toEqual({ probe: { note: 'ya' } });
    fireEvent.click(screen.getByRole('button', { name: 'Descartar' }));
    await advance(10);
    expect(api.controls.storedDrafts()).toEqual({});
    expect(note()).toHaveValue('');
  });

  it('sends pending edits to the server when the screen is left before the debounce fires', async () => {
    const api = createMockApi();
    const view = await mount({ api });
    fireEvent.change(note(), { target: { value: 'al salir' } });
    view.unmount();
    await advance(10);
    expect(api.controls.storedDrafts()).toEqual({ probe: { note: 'al salir' } });
  });

  it('expires the session when loading the draft answers 401', async () => {
    const api = createMockApi();
    const realLoad = api.drafts.load;
    api.drafts.load = async (scope) => {
      api.controls.expireSession();
      return realLoad(scope);
    };
    await mount({ api });
    expect(screen.getByTestId('session')).toHaveTextContent('expired');
  });

  it('expires the session when discarding the draft answers 401', async () => {
    const api = createMockApi();
    await mount({ api });
    api.controls.expireSession();
    fireEvent.click(screen.getByRole('button', { name: 'Descartar' }));
    await advance(10);
    expect(screen.getByTestId('session')).toHaveTextContent('expired');
  });

  function Host() {
    const [shown, setShown] = React.useState(true);
    const { login } = useSession();
    return (
      <div>
        <button onClick={() => setShown((value) => !value)}>Alternar</button>
        <button onClick={() => void login(demoCredentials.admin)}>Reautenticar</button>
        <button onClick={() => void login(demoCredentials.viewer)}>Entrar como consulta</button>
        {shown && <Probe />}
      </div>
    );
  }
  const toggle = () => fireEvent.click(screen.getByRole('button', { name: 'Alternar' }));

  it('holds unsent edits outside the screen when it unmounts while the session is expired', async () => {
    const api = createMockApi();
    await act(async () => renderWithSession(<Host />, { api }));
    await advance(10);
    api.controls.expireSession();
    fireEvent.change(note(), { target: { value: 'pendiente' } });
    await advance(draftSaveDelayMs + 10);
    expect(screen.getByTestId('session')).toHaveTextContent('expired');
    toggle();
    await advance(10);
    fireEvent.click(screen.getByRole('button', { name: 'Reautenticar' }));
    await advance(50);
    toggle();
    await advance(draftSaveDelayMs + 50);
    expect(note()).toHaveValue('pendiente');
    expect(api.controls.storedDrafts()).toEqual({ probe: { note: 'pendiente' } });
  });

  it('does not restore a server draft whose discard failed, and retries the discard', async () => {
    const api = createMockApi();
    await api.auth.login(demoCredentials.admin);
    await api.drafts.save('probe', { note: 'ya descartado' });
    await act(async () => renderWithSession(<Host />, { api }));
    await advance(10);
    expect(note()).toHaveValue('ya descartado');
    api.controls.failNext('discardDraft');
    fireEvent.click(screen.getByRole('button', { name: 'Descartar' }));
    await advance(10);
    expect(note()).toHaveValue('');
    expect(api.controls.storedDrafts()).toEqual({ probe: { note: 'ya descartado' } });
    toggle();
    await advance(10);
    toggle();
    await advance(50);
    expect(note()).toHaveValue('');
    expect(api.controls.storedDrafts()).toEqual({});
  });

  it('forgets held edits when a different person signs in', async () => {
    const api = createMockApi();
    await act(async () => renderWithSession(<Host />, { api }));
    await advance(10);
    api.controls.expireSession();
    fireEvent.change(note(), { target: { value: 'de la primera persona' } });
    await advance(draftSaveDelayMs + 10);
    toggle();
    await advance(10);
    fireEvent.click(screen.getByRole('button', { name: 'Entrar como consulta' }));
    await advance(50);
    toggle();
    await advance(draftSaveDelayMs + 50);
    expect(note()).toHaveValue('');
    expect(api.controls.storedDrafts()).toEqual({});
  });

  describe.each([
    ['another person', undefined],
    ['a person from another company', 'company-otra'],
  ] as const)('edit, sign out, then %s signs in', (_label, otherCompany) => {
    it('shows no trace of the previous edits and saves nothing of them', async () => {
      const api = createMockApi();
      const realLogin = api.auth.login;
      api.auth.login = async (input) => {
        const result = await realLogin(input);
        return result.ok && otherCompany && input.email === demoCredentials.viewer.email
          ? { ok: true, value: { ...result.value, company: { id: otherCompany, name: 'Otra SA' } } }
          : result;
      };
      function Outside() {
        const { login } = useSession();
        return (
          <button onClick={() => void login(demoCredentials.viewer)}>Entrar como consulta</button>
        );
      }
      await act(async () => renderWithSession(<Probe />, { api, outside: <Outside /> }));
      await advance(10);
      fireEvent.change(note(), { target: { value: 'texto de la primera persona' } });
      fireEvent.click(screen.getByRole('button', { name: 'Salir' }));
      await advance(draftSaveDelayMs + 50);
      fireEvent.click(screen.getByRole('button', { name: 'Entrar como consulta' }));
      await advance(draftSaveDelayMs + 50);
      expect(note()).toHaveValue('');
      expect(api.controls.storedDrafts()).toEqual({});
      expect(document.body.textContent).not.toContain('primera persona');
      await realLogin(demoCredentials.admin);
      expect(api.controls.storedDrafts()).toEqual({});
    });
  });
});
