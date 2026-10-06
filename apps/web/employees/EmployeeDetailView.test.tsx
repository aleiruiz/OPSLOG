import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RouterProvider } from '../app/router';
import { dialogClosed, EmployeeDetailView, statusPanelClosed } from './EmployeeDetailView';
import { demoAreas } from '../areas/fixtures';
import { demoHistory, makeEmployeeDetail } from './fixtures';

const noop = () => undefined;
const view = (can: (permission: string) => boolean, piiRevealed = false) =>
  render(
    <RouterProvider>
      <EmployeeDetailView
        state={{
          status: 'ready',
          data: { employee: makeEmployeeDetail(), areas: demoAreas() },
        }}
        history={{
          state: { status: 'ready', data: { items: demoHistory(), nextCursor: null, total: 4 } },
          onRetry: noop,
          onLoadMore: noop,
        }}
        can={can as never}
        dialog={dialogClosed}
        statusPanel={statusPanelClosed}
        piiRevealed={piiRevealed}
        onRetry={noop}
        onStatusOpen={noop}
        onStatusCancel={noop}
        onStatusSubmit={noop}
        onStatusErrorAction={noop}
        onArchiveRequest={noop}
        onDialogConfirm={noop}
        onDialogCancel={noop}
        onDialogErrorAction={noop}
      />
    </RouterProvider>,
  );

describe('EmployeeDetailView personal data', () => {
  it('renders no personal text and no reveal button without view_pii, even if pii is present', () => {
    // Defence in depth: the server never sends it, but the view must not trust that.
    const { container } = view((permission) => permission !== 'view_pii', true);
    expect(container).not.toHaveTextContent(/EJEM800101|\+525555550100|ana\.garcia|LIC-000123/);
    expect(screen.queryByRole('button', { name: /datos personales/i })).toBeNull();
  });

  it('exposes the reveal toggle state and what it controls', () => {
    view(() => true);
    const toggle = screen.getByRole('button', { name: 'Mostrar datos personales' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(document.getElementById(toggle.getAttribute('aria-controls') ?? '')).not.toBeNull();
    toggle.click();
  });
});
