import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './ConfirmDialog';

afterEach(cleanup);

const props = {
  title: 'Archivar registro',
  description: 'No se puede deshacer.',
  confirmLabel: 'Archivar',
};

describe('ConfirmDialog', () => {
  it('is a labelled, described modal whose first focus is the safe choice', async () => {
    render(<ConfirmDialog {...props} onConfirm={() => undefined} onCancel={() => undefined} />);
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAccessibleName('Archivar registro');
    expect(dialog).toHaveAccessibleDescription('No se puede deshacer.');
    expect(
      screen.getByRole('heading', { name: 'Archivar registro', level: 2 }),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Cancelar' })).toHaveFocus();
  });

  it('confirms, cancels with the button or Escape, and uses a custom cancel label', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog {...props} cancelLabel="Mejor no" onConfirm={onConfirm} onCancel={onCancel} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Archivar' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Mejor no' }));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it('cannot be dismissed while busy', () => {
    const onCancel = vi.fn();
    render(<ConfirmDialog {...props} busy onConfirm={() => undefined} onCancel={onCancel} />);
    expect(screen.getByRole('button', { name: 'Cancelar' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cargando…' })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('shows a failure inside the dialog with its recovery action, only when both are given', () => {
    const onErrorAction = vi.fn();
    const { rerender } = render(
      <ConfirmDialog
        {...props}
        error="Cambió mientras lo revisabas."
        errorActionLabel="Recargar"
        onErrorAction={onErrorAction}
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Cambió mientras lo revisabas.');
    fireEvent.click(screen.getByRole('button', { name: 'Recargar' }));
    expect(onErrorAction).toHaveBeenCalledTimes(1);
    rerender(
      <ConfirmDialog
        {...props}
        error="Falló."
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Falló.');
    expect(screen.queryByRole('button', { name: 'Recargar' })).toBeNull();
  });

  it('moves focus to the safe choice once it has opened if the focus trap left it on the container', async () => {
    render(<ConfirmDialog {...props} onConfirm={() => undefined} onCancel={() => undefined} />);
    const dialog = await screen.findByRole('dialog');
    const cancel = within(dialog).getByRole('button', { name: 'Cancelar' });
    // The focus trap (or StrictMode in development) can leave focus on the dialog container.
    act(() => (dialog.parentElement as HTMLElement).focus());
    await waitFor(() => expect(cancel).toHaveFocus());
  });

  it('respects a control the person already focused before the opening transition ended', async () => {
    render(<ConfirmDialog {...props} onConfirm={() => undefined} onCancel={() => undefined} />);
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Archivar' });
    act(() => confirm.focus());
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(confirm).toHaveFocus();
  });
});
