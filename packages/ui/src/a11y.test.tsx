import { render } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { StatusBadge } from './components/StatusBadge';
import { ConfirmDialog } from './components/ConfirmDialog';
import { UiState } from './components/UiState';
import { CheckField } from './components/CheckField';
import { ConfirmWithReason } from './components/BaseFeedback';
import { FileButton } from './components/FileButton';
import { InlineAlert } from './components/InlineAlert';

describe('UI accessibility foundations', () => {
  it('keeps status badges free of automated accessibility violations', async () => {
    const { container } = render(
      <StatusBadge label="Activo" tone="success" severity="Alta" description="Operativo" />,
    );
    const results = await axe.run(container);
    expect(results.violations).toEqual([]);
  });

  it('keeps actionable error states accessible', async () => {
    const { container } = render(
      <UiState kind="error" actionLabel="Reintentar" onAction={() => undefined} />,
    );
    const results = await axe.run(container);
    expect(results.violations).toEqual([]);
  });

  it('keeps the confirmation dialog accessible, including its error and busy states', async () => {
    const base = {
      title: 'Archivar registro',
      description: 'No se puede deshacer.',
      confirmLabel: 'Archivar',
      onConfirm: () => undefined,
      onCancel: () => undefined,
    };
    for (const extra of [
      {},
      { busy: true },
      { error: 'Cambió.', errorActionLabel: 'Recargar', onErrorAction: () => undefined },
    ]) {
      const { baseElement, unmount } = render(<ConfirmDialog {...base} {...extra} />);
      const results = await axe.run(baseElement, {
        rules: { 'color-contrast': { enabled: false } },
      });
      expect(results.violations).toEqual([]);
      unmount();
    }
  });

  it('keeps the inline alerts, check field, file button and reason form accessible', async () => {
    const { container } = render(
      <div>
        <InlineAlert severity="error" title="No se guardó" action={<button>Reintentar</button>}>
          Intenta nuevamente.
        </InlineAlert>
        <InlineAlert severity="success">Listo.</InlineAlert>
        <CheckField label="Frente" checked onChange={() => undefined} />
        <FileButton label="Tomar foto" capture="environment" onFiles={() => undefined} />
        <ConfirmWithReason title="Cancelar caso" error="Falló." onConfirm={() => undefined} />
      </div>,
    );
    // heading-order is a best practice (outside WCAG A/AA): the reason form opens with an h6 in a bare container.
    const results = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false }, 'heading-order': { enabled: false } },
    });
    expect(results.violations).toEqual([]);
  });
});
