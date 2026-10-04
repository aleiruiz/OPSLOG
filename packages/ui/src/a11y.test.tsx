import { render } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { StatusBadge } from './components/StatusBadge';
import { UiState } from './components/UiState';

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
});
