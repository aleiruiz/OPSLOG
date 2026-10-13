import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { BffCostLineInput } from '@opslog/contracts';
import { completeEvent } from './fakePorts';
import type { FakeOrder } from './fakeCosts';
import { ADMIN, RoutedDetail, VIEWER, renderIncident, violations, type View } from './testing';

const press = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));
const fill = (label: string | RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

const review = (overrides: Parameters<typeof completeEvent>[0] = {}) =>
  completeEvent({
    status: 'under_review',
    version: 4,
    responsible: { id: 'user-2', displayName: 'Responsable de flotilla 1' },
    ...overrides,
  });
const mxn = (amountMinor: string) => ({ amountMinor, currency: 'MXN' });
const line = (
  kind: BffCostLineInput['kind'],
  category: BffCostLineInput['category'],
  amountMinor: string,
  currency = 'MXN',
): BffCostLineInput => ({ kind, category, amount: { amountMinor, currency } });
const ORDER: FakeOrder = {
  id: 'order-1',
  vehicleId: 'veh-001',
  description: 'Cambio de defensa',
  costs: [mxn('1000000')],
};

/** Seeds the links and lines through the same ports the screens use, before the first render. */
function seeded(lines: BffCostLineInput[], link = true): NonNullable<View['prepare']> {
  return (fake) => {
    let version = 4;
    if (link)
      void fake.ports.repairs
        .link('inc-001', { version, orderId: 'order-1' }, 'seed-link')
        .then((r) => {
          if (r.ok) version = r.value.version;
        });
    void fake.ports.costs.update('inc-001', { version: link ? 5 : version, lines }, 'seed-costs');
  };
}
const open = (incident = review(), view: View = {}, tab = 'costs') =>
  renderIncident(<RoutedDetail />, {
    path: `/incidents/${incident.id}/${tab}`,
    ...view,
    options: { incidents: [incident], orders: [ORDER], ...view.options },
  });

describe('costs tab', () => {
  it('shows the formula in one currency: repair + deductible + towing - insurer', async () => {
    const { container } = open(review(), {
      prepare: seeded([
        line('expense', 'deductible', '200000'),
        line('expense', 'towing', '50000'),
        line('recovery', 'insurer', '800000'),
      ]),
    });
    const totals = await screen.findByRole('table', { name: /Totales en 1 moneda/ });
    expect(totals).toHaveTextContent('10,000.00 MXN');
    expect(totals).toHaveTextContent('2,500.00 MXN');
    expect(totals).toHaveTextContent('8,000.00 MXN');
    expect(within(totals).getByText('4,500.00 MXN')).toBeInTheDocument();
    expect(screen.queryByText(/más de una moneda/)).toBeNull();
    const lines = screen.getByRole('table', { name: /3 líneas de costo/ });
    expect(lines).toHaveTextContent('Deducible');
    expect(lines).toHaveTextContent('Pago de la aseguradora');
    expect(await screen.findByRole('table', { name: /órdenes vinculadas/ })).toHaveTextContent(
      'Cambio de defensa',
    );
    expect(document.body.textContent).not.toMatch(/order-1|link-1|line-\d|inc-001/);
    expect(await violations(container)).toEqual([]);
  });

  it('keeps currencies apart: one row each, a warning and no combined total', async () => {
    open(review(), { prepare: seeded([line('expense', 'towing', '50000', 'USD')]) });
    const totals = await screen.findByRole('table', { name: /Totales en 2 monedas/ });
    expect(
      screen.getByText(/Los totales se muestran por moneda y no se suman entre sí/),
    ).toBeInTheDocument();
    expect(within(totals).getAllByRole('row')).toHaveLength(3);
    expect(totals).toHaveTextContent('500.00 USD');
    expect(totals).toHaveTextContent('10,000.00 MXN');
  });

  it('shows a negative total when recoveries are above the costs', async () => {
    open(review(), { prepare: seeded([line('recovery', 'third_party', '2000000')], false) });
    const totals = await screen.findByRole('table', { name: /Totales en 1 moneda/ });
    expect(within(totals).getByText('-20,000.00 MXN')).toBeInTheDocument();
  });

  it('adds a line and saves it with one keyed request that carries the version', async () => {
    const { fake } = open(review(), { prepare: seeded([], false) });
    await screen.findByText('Sin gastos ni recuperaciones');
    const update = vi.spyOn(fake.ports.costs, 'update');
    press('Agregar línea');
    fill('Concepto', 'towing');
    fill(/^Monto/, '500.5');
    fill(/Nota/, 'Grúa al taller');
    fireEvent.click(
      within(screen.getByRole('form', { name: 'Agregar línea de costo' })).getByRole('button', {
        name: 'Agregar línea',
      }),
    );
    expect(await screen.findByText('Sin guardar')).toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
    press('Guardar costos');
    expect(await screen.findByText('Costos guardados.')).toBeInTheDocument();
    expect(update).toHaveBeenCalledTimes(1);
    const [id, body, key] = update.mock.calls[0] as [
      string,
      { version: number; lines: unknown[] },
      string,
    ];
    expect(id).toBe('inc-001');
    expect(body.version).toBeGreaterThanOrEqual(4);
    expect(body.lines).toEqual([
      { kind: 'expense', category: 'towing', amount: mxn('50050'), note: 'Grúa al taller' },
    ]);
    expect(key).toMatch(/\S{8,}/);
    const totals = await screen.findByRole('table', { name: /Totales en 1 moneda/ });
    expect(within(totals).getAllByText('500.50 MXN').length).toBeGreaterThan(0);
    expect(screen.queryByText('Sin guardar')).toBeNull();
  });

  it('refuses an amount or currency the server would refuse, before sending anything', async () => {
    const { fake } = open(review(), { prepare: seeded([], false) });
    await screen.findByText('Sin gastos ni recuperaciones');
    press('Agregar línea');
    const form = screen.getByRole('form', { name: 'Agregar línea de costo' });
    const submit = () =>
      fireEvent.click(within(form).getByRole('button', { name: 'Agregar línea' }));
    fill(/^Monto/, '0');
    submit();
    expect(await within(form).findByRole('alert')).toHaveTextContent('mayor a cero');
    fill(/^Monto/, '10.999');
    submit();
    expect(await within(form).findByRole('alert')).toHaveTextContent('mayor a cero');
    fill(/^Monto/, '10');
    fill(/^Moneda( \*)?$/, 'mx');
    submit();
    expect(await within(form).findByRole('alert')).toHaveTextContent('tres letras');
    // Only the seeding call: nothing was sent from the form.
    expect(fake.calls.filter((call) => call === 'costs.update')).toHaveLength(1);
  });

  it('edits and removes saved lines, and discards what was not saved', async () => {
    const { fake } = open(review(), {
      prepare: seeded([line('expense', 'fine', '30000'), line('expense', 'legal', '70000')], false),
    });
    await screen.findByRole('table', { name: /2 líneas de costo/ });
    const update = vi.spyOn(fake.ports.costs, 'update');
    press('Editar Multa');
    fill(/^Monto/, '450');
    fireEvent.click(
      within(screen.getByRole('form', { name: 'Editar línea de costo' })).getByRole('button', {
        name: 'Actualizar línea',
      }),
    );
    press('Quitar Gastos legales');
    expect(screen.getByRole('table', { name: /1 líneas de costo/ })).toHaveTextContent(
      '450.00 MXN',
    );
    press('Descartar cambios');
    expect(screen.getByRole('table', { name: /2 líneas de costo/ })).toHaveTextContent(
      '300.00 MXN',
    );
    press('Quitar Gastos legales');
    press('Guardar costos');
    await screen.findByText('Costos guardados.');
    const body = update.mock.calls[0]?.[1] as unknown as {
      lines: { id: string; category: string }[];
    };
    expect(body.lines).toHaveLength(1);
    expect(body.lines[0]?.category).toBe('fine');
    expect(body.lines[0]?.id).toMatch(/^line-/);
  });

  it('keeps what was typed after a conflict, brings the other change, and resends one merged list', async () => {
    const { fake } = open(review(), { prepare: seeded([line('expense', 'fine', '30000')], false) });
    await screen.findByRole('table', { name: /1 líneas de costo/ });
    press('Agregar línea');
    fill('Concepto', 'towing');
    fill(/^Monto/, '500');
    fireEvent.click(
      within(screen.getByRole('form', { name: 'Agregar línea de costo' })).getByRole('button', {
        name: 'Agregar línea',
      }),
    );
    // Somebody else adds a line meanwhile.
    fake.changeCostsExternally('inc-001', [
      { id: 'line-other', kind: 'expense', category: 'legal', amount: mxn('70000'), note: null },
    ]);
    press('Guardar costos');
    expect(await screen.findByText(/El caso cambió mientras lo editabas/)).toBeInTheDocument();
    expect(screen.getByText('Sin guardar')).toBeInTheDocument();
    const update = vi.spyOn(fake.ports.costs, 'update');
    fireEvent.click(screen.getByRole('button', { name: 'Recargar' }));
    await screen.findByRole('table', { name: /3 líneas de costo/ });
    expect(screen.getByText('Sin guardar')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: /3 líneas de costo/ })).toHaveTextContent(
      'Gastos legales',
    );
    press('Guardar costos');
    await screen.findByText('Costos guardados.');
    const body = update.mock.calls[0]?.[1] as unknown as { lines: { category: string }[] };
    expect(body.lines.map((item) => item.category).sort()).toEqual(['fine', 'legal', 'towing']);
  });

  it('shows the estimate and the deductible as references, a percentage never as an amount', async () => {
    open(review(), {
      options: { policyDeductible: { kind: 'percent', basisPoints: 1250 } },
      prepare: (fake) => {
        void fake.ports.costs.update(
          'inc-001',
          { version: 4, lines: [], initialEstimate: mxn('2500000') },
          'seed',
        );
      },
    });
    await screen.findByText('Estimación y deducible');
    expect(screen.getByLabelText('Estimación inicial')).toHaveValue('25000.00');
    expect(screen.getByText('12.5 % del monto reclamado')).toBeInTheDocument();
    expect(screen.queryByText(/25,000/)).toBeNull();
    fill('Estimación inicial', '');
    press('Guardar costos');
    await screen.findByText('Costos guardados.');
    expect(screen.getByLabelText('Estimación inicial')).toHaveValue('');
  });

  it('shows the deductible of a policy as an amount', async () => {
    open(review(), {
      options: { policyDeductible: { kind: 'amount', amountMinor: '300000', currency: 'MXN' } },
      permissions: [...VIEWER, 'incidents:view_costs'],
    });
    expect(await screen.findByText('3,000.00 MXN')).toBeInTheDocument();
    expect(screen.getByText('Sin estimación')).toBeInTheDocument();
  });

  it('gives a reader with view_costs the numbers and no buttons', async () => {
    open(review(), {
      permissions: [...VIEWER, 'incidents:view_costs'],
      prepare: (fake) =>
        fake.changeCostsExternally('inc-001', [
          { id: 'l1', kind: 'expense', category: 'towing', amount: mxn('50000'), note: null },
        ]),
    });
    await screen.findByRole('table', { name: /Totales en 1 moneda/ });
    expect(screen.queryByRole('button', { name: /Agregar línea|Guardar costos/ })).toBeNull();
  });

  it('never asks for, nor draws, a cost without incidents:view_costs', async () => {
    const permissions = ['incidents:view', 'incidents:edit', 'view'];
    const { fake } = open(review(), {
      permissions,
      prepare: seeded([line('expense', 'towing', '99900')], false),
    });
    await screen.findByRole('tab', { name: 'Reparación' });
    expect(screen.queryByRole('tab', { name: 'Costos' })).toBeNull();
    // The deep link to the tab lands on the summary and nothing is requested.
    await screen.findByText('Datos del evento');
    for (const tab of ['Resumen', 'Terceros', 'Evidencia', 'Seguro', 'Reparación', 'Timeline']) {
      fireEvent.click(screen.getByRole('tab', { name: tab }));
      await waitFor(() =>
        expect(screen.getByRole('tab', { name: tab })).toHaveAttribute('aria-selected', 'true'),
      );
    }
    expect(fake.calls).not.toContain('costs.get');
    expect(document.body.textContent).not.toMatch(/999\.00|99900|\bMXN\b/);
    expect(document.body.innerHTML).not.toMatch(/999\.00|99900/);
  });

  it('says so when the server refuses the costs, and retries a failed load', async () => {
    const { unmount } = open(review(), { prepare: (fake) => fake.failNext('costs.get', 500) });
    fireEvent.click(await screen.findByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByText('Totales a cargo de la empresa')).toBeInTheDocument();
    unmount();
    open(review(), { prepare: (fake) => fake.failNext('costs.get', 403) });
    expect(await screen.findByText('No tienes acceso')).toBeInTheDocument();
  });

  it('shows the cost at each closing and warns when the costs changed afterwards', async () => {
    const closing = review({ status: 'resolved', version: 7 });
    const resolved = {
      ...closing,
      resolution: {
        ...closing.resolution,
        resolutionSummary: 'Listo',
        vehicleStatusDecision: 'active' as const,
      },
    };
    const { fake } = open(resolved, {
      prepare: (f) => {
        void f.ports.costs.update(
          'inc-001',
          { version: 7, lines: [line('expense', 'towing', '50000')] },
          's',
        );
      },
    });
    await screen.findByRole('table', { name: /Totales en 1 moneda/ });
    expect(screen.queryByText('Costos al cierre')).toBeNull();
    await fake.ports.transition('inc-001', { version: 8, command: 'close' }, 'close-1');
    fake.changeCostsExternally('inc-001', [
      { id: 'late', kind: 'expense', category: 'fine', amount: mxn('10000'), note: null },
    ]);
    fireEvent.click(screen.getByRole('tab', { name: 'Resumen' }));
    fireEvent.click(await screen.findByRole('tab', { name: 'Costos' }));
    const closings = await screen.findByRole('table', { name: '1 cierres' });
    expect(closings).toHaveTextContent('Ciclo 1');
    expect(closings).toHaveTextContent('500.00 MXN');
    expect(
      await screen.findByText(/Los costos cambiaron desde el último cierre/),
    ).toBeInTheDocument();
  });
});

describe('cost approval (D20)', () => {
  const resolved = () => {
    const base = review({ status: 'resolved', version: 6 });
    return {
      ...base,
      resolution: {
        ...base.resolution,
        resolutionSummary: 'Listo',
        vehicleStatusDecision: 'active' as const,
      },
    };
  };
  const panel = () => screen.getByRole('region', { name: 'Aprobación de costos' });

  it('shows the threshold to who may see amounts, and that an approval is pending, without comparing', async () => {
    open(resolved(), {
      options: { thresholdConfigured: true, approvalRequired: true },
      env: { approvalThreshold: mxn('100000') },
    });
    await screen.findByRole('region', { name: 'Aprobación de costos' });
    expect(within(panel()).getByText(/1,000\.00 MXN: arriba de este costo/)).toBeInTheDocument();
    expect(await within(panel()).findByRole('status')).toHaveTextContent(
      'necesita la aprobación de una persona supervisora',
    );
    expect(within(panel()).getAllByText('Sin aprobación')).toHaveLength(2);
  });

  it('shows who approved and says nothing is pending afterwards', async () => {
    open(resolved(), {
      options: { thresholdConfigured: true, approvalRequired: true },
      env: { approvalThreshold: mxn('100000') },
    });
    await screen.findByRole('region', { name: 'Aprobación de costos' });
    press('Aprobar cierre');
    expect(await within(panel()).findByText(/Tú · 13\/10\/2026/)).toBeInTheDocument();
    await waitFor(() => expect(within(panel()).queryByRole('status')).toBeNull());
  });

  it('says there is no threshold when the company has none', async () => {
    open(resolved(), { permissions: ADMIN });
    await screen.findByRole('region', { name: 'Aprobación de costos' });
    expect(
      within(panel()).getByText('La empresa no tiene un umbral configurado'),
    ).toBeInTheDocument();
    expect(within(panel()).queryByRole('status')).toBeNull();
  });
});
