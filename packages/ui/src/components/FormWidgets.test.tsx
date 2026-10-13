import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CheckField } from './CheckField';
import { ConfirmWithReason } from './BaseFeedback';
import { FileButton } from './FileButton';
import { InlineAlert } from './InlineAlert';

afterEach(cleanup);

describe('InlineAlert', () => {
  it('announces errors and warnings at once and information without interrupting', () => {
    const { rerender } = render(<InlineAlert severity="error">No se guardó.</InlineAlert>);
    expect(screen.getByRole('alert')).toHaveTextContent('No se guardó.');
    rerender(<InlineAlert severity="warning">Cuidado.</InlineAlert>);
    expect(screen.getByRole('alert')).toHaveTextContent('Cuidado.');
    rerender(<InlineAlert severity="success">Listo.</InlineAlert>);
    expect(screen.getByRole('status')).toHaveTextContent('Listo.');
    rerender(<InlineAlert>Información.</InlineAlert>);
    expect(screen.getByRole('status')).toHaveTextContent('Información.');
  });

  it('shows an optional title and a recovery action', () => {
    const onReload = vi.fn();
    render(
      <InlineAlert
        severity="warning"
        title="El caso cambió"
        action={<button onClick={onReload}>Recargar</button>}
      >
        Otra persona lo editó.
      </InlineAlert>,
    );
    expect(screen.getByText('El caso cambió')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Recargar' }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });
});

describe('CheckField', () => {
  it('reports the new state and honours disabled', () => {
    const onChange = vi.fn();
    const { rerender } = render(<CheckField label="Frente" checked={false} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText('Frente'));
    expect(onChange).toHaveBeenCalledWith(true);
    rerender(<CheckField label="Frente" checked onChange={onChange} />);
    expect(screen.getByLabelText('Frente')).toBeChecked();
    rerender(<CheckField label="Frente" checked disabled onChange={onChange} />);
    expect(screen.getByLabelText('Frente')).toBeDisabled();
  });
});

describe('FileButton', () => {
  const file = (name: string) => new File(['x'], name, { type: 'image/jpeg' });

  it('names the native input by its label and hands over the chosen files, then clears it', () => {
    const onFiles = vi.fn();
    render(<FileButton label="Adjuntar archivo" accept="image/*" multiple onFiles={onFiles} />);
    const input = screen.getByLabelText('Adjuntar archivo') as HTMLInputElement;
    expect(input).toHaveAttribute('type', 'file');
    expect(input).toHaveAttribute('accept', 'image/*');
    fireEvent.change(input, { target: { files: [file('a.jpg'), file('b.jpg')] } });
    expect(onFiles).toHaveBeenCalledWith([expect.any(File), expect.any(File)]);
    expect(input.value).toBe('');
  });

  it('opens the camera with capture, ignores an empty choice and is inert when disabled', () => {
    const onFiles = vi.fn();
    const { rerender } = render(
      <FileButton
        label="Tomar foto"
        capture="environment"
        icon={<svg aria-hidden="true" />}
        onFiles={onFiles}
      />,
    );
    const input = screen.getByLabelText('Tomar foto');
    expect(input).toHaveAttribute('capture', 'environment');
    fireEvent.change(input, { target: { files: [] } });
    expect(onFiles).not.toHaveBeenCalled();
    rerender(<FileButton label="Tomar foto" disabled onFiles={onFiles} />);
    expect(screen.getByLabelText('Tomar foto')).toBeDisabled();
  });
});

describe('ConfirmWithReason additions', () => {
  it('uses a custom confirm label and description, shows an error and locks while busy', () => {
    const onConfirm = vi.fn();
    const { rerender } = render(
      <ConfirmWithReason
        title="Cancelar caso"
        confirmLabel="Cancelar caso"
        description="El caso quedará cancelado."
        error="No pudimos cancelarlo."
        onConfirm={onConfirm}
        onCancel={() => undefined}
      />,
    );
    expect(screen.getByText('El caso quedará cancelado.')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('No pudimos cancelarlo.');
    fireEvent.change(screen.getByLabelText(/Motivo/), { target: { value: 'duplicado' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar caso' }));
    expect(onConfirm).toHaveBeenCalledWith('duplicado');
    rerender(
      <ConfirmWithReason
        title="Cancelar caso"
        busy
        onConfirm={onConfirm}
        onCancel={() => undefined}
      />,
    );
    expect(screen.getByRole('button', { name: 'Cargando…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancelar' })).toBeDisabled();
  });
});
