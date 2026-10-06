import { act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { makeArea } from './fixtures';
import { createMockApi } from '../app/mockApi';
import { click, fireEvent, renderApp, screen, within } from '../app/test/utils';

const item = (name: string | RegExp) => screen.getByRole('treeitem', { name });
const names = () =>
  screen.getAllByRole('treeitem').map((node) => node.getAttribute('aria-labelledby'));

async function openTree(options: Parameters<typeof renderApp>[0] = {}) {
  const view = await renderApp({ path: '/plantilla/areas', ...options });
  await screen.findByRole('tree', { name: 'Estructura de áreas' });
  return view;
}
const key = (target: HTMLElement, name: string) => fireEvent.keyDown(target, { key: name });

describe('areas tree screen', () => {
  it('shows the tree with levels, sub-area counts and the first two levels open', async () => {
    await openTree();
    const tree = screen.getByRole('tree');
    expect(within(tree).getAllByRole('treeitem')).toHaveLength(8);
    const norte = item(/^Norte/);
    expect(norte).toHaveAttribute('aria-level', '1');
    expect(norte).toHaveAttribute('aria-expanded', 'true');
    expect(norte).toHaveAttribute('aria-setsize', '3');
    expect(norte).toHaveAttribute('aria-posinset', '2');
    expect(item(/^Monterrey/)).toHaveAttribute('aria-level', '2');
    expect(item(/^Monterrey/)).toHaveAttribute('aria-expanded', 'false');
    expect(item(/^Chihuahua/)).not.toHaveAttribute('aria-expanded');
    expect(norte).toHaveAccessibleName(/^Norte/);
    // The accessible name is the row's own label, not the whole branch below it.
    expect(norte).not.toHaveAccessibleName(expect.stringContaining('Monterrey'));
    expect(screen.getAllByText(/2 sub-áreas · 1 responsable/)).toHaveLength(2);
    expect(screen.getAllByText('0 sub-áreas · 0 responsables').length).toBeGreaterThan(0);
    expect(screen.getByText('12 áreas')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Nueva área' })).toHaveAttribute(
      'href',
      '/plantilla/areas/nueva',
    );
  });

  it('is reachable from the navigation group "Plantilla" and highlights its entry', async () => {
    await renderApp();
    const nav = await screen.findByRole('navigation', { name: 'Principal' });
    const link = within(within(nav).getByRole('region', { name: 'Plantilla' })).getByRole('link', {
      name: 'Áreas',
    });
    fireEvent.click(link);
    await screen.findByRole('tree');
    expect(link).toHaveAttribute('aria-current', 'page');
  });

  it('has a single tab stop that follows the keyboard (roving tabindex)', async () => {
    await openTree();
    const stops = screen.getAllByRole('treeitem').filter((node) => node.tabIndex === 0);
    expect(stops).toHaveLength(1);
    expect(stops[0]).toBe(item(/^Centro/));
    item(/^Centro/).focus();
    key(item(/^Centro/), 'ArrowDown');
    expect(item(/^Ciudad de México/)).toHaveFocus();
    expect(item(/^Ciudad de México/).tabIndex).toBe(0);
    expect(item(/^Centro/).tabIndex).toBe(-1);
  });

  it('moves with the arrow keys, Home and End, and opens and closes branches', async () => {
    await openTree();
    const first = item(/^Centro/);
    first.focus();
    key(first, 'End');
    // The last visible item is the child of the open root "Sur".
    expect(item(/^Mérida/)).toHaveFocus();
    key(item(/^Mérida/), 'Home');
    expect(item(/^Centro/)).toHaveFocus();
    key(item(/^Centro/), 'ArrowUp');
    expect(item(/^Centro/)).toHaveFocus();
    // Right on an open branch goes to its first child; Left on a child goes back to the parent.
    key(item(/^Centro/), 'ArrowRight');
    expect(item(/^Ciudad de México/)).toHaveFocus();
    key(item(/^Ciudad de México/), 'ArrowLeft');
    expect(item(/^Centro/)).toHaveFocus();
    // Left on an open branch closes it, and Right on a closed one opens it again.
    key(item(/^Centro/), 'ArrowLeft');
    expect(item(/^Centro/)).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('treeitem', { name: /^Querétaro/ })).toBeNull();
    key(item(/^Centro/), 'ArrowRight');
    expect(item(/^Centro/)).toHaveAttribute('aria-expanded', 'true');
    // Right on a leaf and Left on a root do nothing.
    item(/^Chihuahua/).focus();
    key(item(/^Chihuahua/), 'ArrowRight');
    expect(item(/^Chihuahua/)).toHaveFocus();
    item(/^Sur/).focus();
    key(item(/^Sur/), 'ArrowLeft');
    key(item(/^Sur/), 'ArrowLeft');
    expect(item(/^Sur/)).toHaveAttribute('aria-expanded', 'false');
    key(item(/^Sur/), 'ArrowLeft');
    expect(item(/^Sur/)).toHaveFocus();
  });

  it('opens the area with Enter or Space, and ignores other keys and modified keys', async () => {
    await openTree();
    item(/^Norte/).focus();
    fireEvent.keyDown(item(/^Norte/), { key: 'a' });
    fireEvent.keyDown(item(/^Norte/), { key: 'Enter', ctrlKey: true });
    expect(screen.getByRole('tree')).toBeInTheDocument();
    key(item(/^Norte/), ' ');
    await screen.findByRole('heading', { name: 'Norte', level: 1 });
    expect(window.location.pathname).toBe('/plantilla/areas/area-norte');
  });

  it('opens an area by clicking its row, and the arrow only toggles the branch', async () => {
    await openTree();
    const arrow = item(/^Monterrey/).querySelector('[aria-hidden="true"]') as HTMLElement;
    fireEvent.click(arrow);
    expect(item(/^Monterrey/)).toHaveAttribute('aria-expanded', 'true');
    expect(window.location.pathname).toBe('/plantilla/areas');
    // Nested levels sit under a group.
    expect(within(item(/^Monterrey/)).getByRole('group')).toBeInTheDocument();
    expect(item(/^Base Apodaca/)).toHaveAttribute('aria-level', '3');
    fireEvent.click(screen.getByText('Querétaro'));
    await screen.findByRole('heading', { name: 'Querétaro', level: 1 });
  });

  it('expands and collapses everything on request, up to the fourth level', async () => {
    await openTree();
    click('Expandir todo');
    expect(screen.getAllByRole('treeitem')).toHaveLength(12);
    expect(screen.getByRole('treeitem', { name: /^Patio de maniobras/ })).toHaveAttribute(
      'aria-level',
      '4',
    );
    click('Contraer todo');
    expect(screen.getAllByRole('treeitem')).toHaveLength(3);
  });

  it('keeps focus on a visible item when its branch collapses around it', async () => {
    await openTree();
    click('Expandir todo');
    const deep = screen.getByRole('treeitem', { name: /^Taller/ });
    act(() => deep.focus());
    expect(deep.tabIndex).toBe(0);
    click('Contraer todo');
    expect(screen.getAllByRole('treeitem').filter((node) => node.tabIndex === 0)).toEqual([
      item(/^Centro/),
    ]);
  });

  it('hides inactive areas by default and shows them, labelled, on request', async () => {
    const api = createMockApi();
    const list = vi.spyOn(api.areas, 'list');
    await openTree({ api });
    expect(list).toHaveBeenCalledWith({ limit: 100, includeInactive: 'false' });
    click('Expandir todo');
    expect(screen.queryByText('Base Guadalupe')).toBeNull();
    fireEvent.change(screen.getByLabelText('Estado'), { target: { value: 'true' } });
    await screen.findByText('13 áreas');
    expect(list).toHaveBeenLastCalledWith({ limit: 100, includeInactive: 'true' });
    click('Expandir todo');
    expect(screen.getByRole('treeitem', { name: /^Base Guadalupe/ })).toBeInTheDocument();
    expect(screen.getByText('Inactiva')).toBeInTheDocument();
    // The inactive state is part of the accessible name; an active area's name does not carry it.
    expect(
      screen.getByRole('treeitem', { name: /^Base Guadalupe.* Inactiva$/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole('treeitem', { name: /^Monterrey/ })).not.toHaveAccessibleName(
      /Inactiva/,
    );
  });

  it('follows the cursor to the end and warns when a page limit cuts the structure short', async () => {
    const api = createMockApi();
    let pages = 0;
    vi.spyOn(api.areas, 'list').mockImplementation(async () => {
      pages += 1;
      return {
        ok: true,
        value: {
          items: [
            {
              ...makeArea(),
              id: `a${pages}`,
              name: `A${pages}`,
              parentId: null,
            },
          ],
          nextCursor: 'mock:1',
          total: 99,
          sort: { field: 'name', direction: 'asc' },
        },
      };
    });
    await openTree({ api });
    expect(pages).toBe(20);
    expect(screen.getByText(/Se muestran las primeras 20 áreas/)).toBeInTheDocument();
    expect(screen.getAllByRole('treeitem')).toHaveLength(20);
  });

  it('shows the empty state with or without permission to create', async () => {
    const view = await renderApp({ api: createMockApi({ areas: [] }), path: '/plantilla/areas' });
    await screen.findByRole('heading', { name: 'Aún no hay áreas' });
    expect(screen.getByText(/Crea la primera área/)).toBeInTheDocument();
    view.unmount();
    await renderApp({
      api: createMockApi({ areas: [] }),
      account: 'viewer',
      path: '/plantilla/areas',
    });
    await screen.findByText('Cuando se creen áreas aparecerán aquí.');
    expect(screen.queryByRole('link', { name: 'Nueva área' })).toBeNull();
  });

  it('lets a read-only role browse the tree without creation actions', async () => {
    await openTree({ account: 'viewer' });
    expect(screen.queryByRole('link', { name: 'Nueva área' })).toBeNull();
    expect(screen.getAllByRole('treeitem').length).toBeGreaterThan(0);
  });

  it('retries after an error', async () => {
    const api = createMockApi();
    api.controls.failNext('listAreas', 500);
    await renderApp({ api, path: '/plantilla/areas' });
    await screen.findByRole('heading', { name: 'No pudimos cargar la información' });
    click('Reintentar');
    await screen.findByRole('tree');
  });

  it('shows the no-permission state when the server answers 403', async () => {
    const api = createMockApi();
    api.controls.failNext('listAreas', 403);
    await renderApp({ api, path: '/plantilla/areas' });
    await screen.findByRole('heading', { name: 'No tienes acceso' });
  });

  it('shows the expired-session state when the server answers 401', async () => {
    const api = createMockApi();
    await renderApp({ api, path: '/plantilla/areas' });
    await screen.findByRole('tree');
    api.controls.expireSession();
    fireEvent.change(screen.getByLabelText('Estado'), { target: { value: 'true' } });
    await screen.findByRole('group', { name: 'Sesión expirada' });
    expect(screen.getByRole('heading', { name: 'Datos no disponibles' })).toBeInTheDocument();
  });

  it('does not use any other keyboard handler inside the filter (typing is not tree navigation)', async () => {
    await openTree();
    const select = screen.getByLabelText('Estado');
    fireEvent.keyDown(select, { key: 'ArrowDown' });
    expect(screen.getAllByRole('treeitem').filter((node) => node.tabIndex === 0)).toHaveLength(1);
    expect(names()).toHaveLength(8);
  });
});
