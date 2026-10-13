import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { UiState } from './UiState';

afterEach(cleanup);

const isBanner = (element: HTMLElement) => element.classList.contains('MuiAlert-root');

describe('UiState layout', () => {
  it('draws whole-list states as blocks with their role and an h2', () => {
    render(<UiState kind="no-results" />);
    const block = screen.getByRole('status');
    expect(isBanner(block)).toBe(false);
    expect(screen.getByRole('heading', { level: 2, name: 'Sin resultados' })).toBeVisible();
  });

  it('draws a failed load (error with an action) as a block alert', () => {
    render(<UiState kind="error" actionLabel="Reintentar" onAction={() => undefined} />);
    const block = screen.getByRole('alert');
    expect(isBanner(block)).toBe(false);
    expect(screen.getByRole('button', { name: 'Reintentar' })).toBeVisible();
  });

  it('keeps an error without an action as a banner', () => {
    render(<UiState kind="error" />);
    expect(isBanner(screen.getByRole('alert'))).toBe(true);
  });

  it('keeps any state a banner when the caller asks for one', () => {
    render(
      <UiState
        kind="error"
        layout="banner"
        actionLabel="Cargar datos actuales"
        onAction={() => undefined}
      />,
    );
    expect(isBanner(screen.getByRole('alert'))).toBe(true);
  });

  it('labels the loading spinner', () => {
    render(<UiState kind="loading" />);
    expect(screen.getByLabelText('Cargando')).toBeInTheDocument();
  });
});
