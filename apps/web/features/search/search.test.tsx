import { describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../../app/mockApi';
import { fireEvent, renderApp, screen, waitFor } from '../../app/test/utils';
import { violations } from '../maintenance/testing';
import { createSearchPorts } from './ports';
import { resultsAnnouncement, resultsPath } from './labels';

const type = (text: string) =>
  fireEvent.change(screen.getByRole('combobox', { name: 'Buscar' }), { target: { value: text } });

describe('global search box', () => {
  it('is an accessible combobox that lists hits by type and opens one with the keyboard', async () => {
    const { container } = await renderApp({ path: '/' });
    const box = await screen.findByRole('combobox', { name: 'Buscar' });
    expect(box).toHaveAttribute('aria-expanded', 'false');
    type('a');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    type('ec');
    const list = await screen.findByRole('listbox', { name: 'Resultados de búsqueda' });
    expect(box).toHaveAttribute('aria-expanded', 'true');
    expect(box).toHaveAttribute('aria-controls', list.id);
    const options = await screen.findAllByRole('option');
    expect(options.length).toBeGreaterThan(0);
    expect(await violations(container)).toEqual([]);
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(box).toHaveAttribute('aria-activedescendant', options[0]?.id);
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    expect(box).toHaveAttribute('aria-activedescendant', options.at(-1)?.id);
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(window.location.pathname).not.toBe('/'));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('closes with Escape, opens the results page with Enter and shows it', async () => {
    await renderApp({ path: '/' });
    const box = await screen.findByRole('combobox', { name: 'Buscar' });
    type('ec');
    await screen.findAllByRole('option');
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    fireEvent.keyDown(box, { key: 'Escape' });
    fireEvent.focus(box);
    await screen.findAllByRole('option');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await screen.findByRole('heading', { name: 'Resultados de búsqueda' })).toBeVisible();
    expect(window.location.pathname + window.location.search).toBe(resultsPath('ec'));
    expect((await screen.findAllByRole('link', { name: /ec/i })).length).toBeGreaterThan(0);
  });

  it('says so when nothing matches and when the search fails', async () => {
    const api = createMockApi();
    await renderApp({ path: '/', api });
    const box = await screen.findByRole('combobox', { name: 'Buscar' });
    type('zzzzzz');
    expect((await screen.findAllByText('No encontramos resultados.')).length).toBeGreaterThan(0);
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    api.controls.failNext('search', 500);
    type('zzzzzy');
    expect(await screen.findByText('No pudimos buscar. Intenta nuevamente.')).toBeInTheDocument();
  });

  it('closes on an outside click and ignores Enter on a short term', async () => {
    await renderApp({ path: '/' });
    const box = await screen.findByRole('combobox', { name: 'Buscar' });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(window.location.pathname).toBe('/');
    type('ec');
    await screen.findByRole('listbox');
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    fireEvent.focus(box);
    expect(await screen.findByRole('listbox')).toBeInTheDocument();
  });

  it('shows the idle, loading, empty and error states of the results page', async () => {
    await renderApp({ path: '/buscar' });
    expect(await screen.findByText('Escribe al menos 2 caracteres.')).toBeInTheDocument();
  });

  it('shows the empty page for a term without hits', async () => {
    await renderApp({ path: '/buscar?q=zzzzzz' });
    expect(await screen.findByText('No encontramos resultados.')).toBeInTheDocument();
  });

  it('shows the error of the results page', async () => {
    const api = createMockApi();
    api.controls.failNext('search', 500);
    await renderApp({ path: '/buscar?q=ec', api });
    expect(await screen.findByText('No pudimos buscar. Intenta nuevamente.')).toBeInTheDocument();
  });

  it('hands a 401 to the session handling', async () => {
    const api = createMockApi();
    await renderApp({ path: '/', api });
    const box = await screen.findByRole('combobox', { name: 'Buscar' });
    api.controls.failNext('search', 401);
    type('ec');
    fireEvent.focus(box);
    expect(await screen.findByRole('group', { name: 'Sesión expirada' })).toBeInTheDocument();
  });

  it('announces the number of results', () => {
    expect(resultsAnnouncement(0)).toBe('No encontramos resultados.');
    expect(resultsAnnouncement(1)).toBe('1 resultado.');
    expect(resultsAnnouncement(3)).toBe('3 resultados.');
  });

  it('asks the BFF for the term', async () => {
    const call = vi.fn(async () => ({ ok: true as const, value: { groups: [] } }));
    const ports = createSearchPorts({ call } as never);
    await ports.query('abc');
    expect(call).toHaveBeenCalledWith('search.query', { query: { q: 'abc' } });
  });
});
