import { act } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { mountApp } from './bootstrap';
import { createMockApi } from './mockApi';
import { screen } from './test/utils';

describe('mountApp', () => {
  it('renders the shell with the theme into a container and unmounts cleanly', async () => {
    window.history.replaceState(null, '', '/iniciar-sesion');
    const container = document.createElement('div');
    document.body.append(container);
    let root: ReturnType<typeof mountApp> | undefined;
    await act(async () => {
      root = mountApp(container, createMockApi());
    });
    expect(await screen.findByRole('heading', { name: 'Iniciar sesión', level: 1 })).toBeVisible();
    act(() => root?.unmount());
    container.remove();
    window.history.replaceState(null, '', '/');
  });
});
