import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { completeEvent } from './fakePorts';
import type { FakeOrder } from './fakeCosts';
import { ADMIN, MANAGER, RoutedDetail, VIEWER, renderIncident, violations } from './testing';

const press = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));

const review = (overrides: Parameters<typeof completeEvent>[0] = {}) =>
  completeEvent({
    status: 'under_review',
    version: 4,
    responsible: { id: 'user-2', displayName: 'Responsable de flotilla 1' },
    ...overrides,
  });
const pick = async (value: string) =>
  fireEvent.change(await screen.findByLabelText(/Orden correctiva del vehículo/), {
    target: { value },
  });
const submitLink = async () =>
  fireEvent.click(
    within(await screen.findByRole('form', { name: 'Vincular orden' })).getByRole('button', {
      name: 'Vincular orden',
    }),
  );
const ORDERS: FakeOrder[] = [
  {
    id: 'order-1',
    vehicleId: 'veh-001',
    description: 'Cambio de defensa',
    workshop: 'Taller Central',
    createdAt: '2026-10-12T16:00:00.000Z',
  },
  {
    id: 'order-2',
    vehicleId: 'veh-001',
    description: 'Pintura',
    createdAt: '2026-10-11T16:00:00.000Z',
  },
  { id: 'order-other', vehicleId: 'veh-002', description: 'Otro vehículo' },
  { id: 'order-prev', vehicleId: 'veh-001', description: 'Preventiva', kind: 'preventive' },
  { id: 'order-void', vehicleId: 'veh-001', description: 'Cancelada', status: 'cancelled' },
];
const open = (
  incident = review(),
  view: Parameters<typeof renderIncident>[1] = {},
  orders: FakeOrder[] = ORDERS,
) =>
  renderIncident(<RoutedDetail />, {
    path: `/incidents/${incident.id}/repair`,
    ...view,
    options: { incidents: [incident], orders, ...view.options },
  });

describe('repair tab', () => {
  it('starts empty, explains how to reach repair and is accessible', async () => {
    const { container } = open();
    expect(await screen.findByText('Sin órdenes vinculadas')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Vincula una orden correctiva o sube un presupuesto para pasar a reparación.',
      ),
    ).toBeInTheDocument();
    expect(await screen.findByText('Sin presupuesto.')).toBeInTheDocument();
    expect(await violations(container)).toEqual([]);
  });

  it('offers only corrective, live orders of the same vehicle, by name and never by id', async () => {
    open();
    await screen.findByText('Sin órdenes vinculadas');
    press('Vincular orden');
    const select = await screen.findByLabelText(/Orden correctiva del vehículo/);
    const labels = within(select)
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(labels).toHaveLength(3);
    expect(labels[1]).toMatch(/^Cambio de defensa · Programada · registrada el 12\/10\/2026/);
    expect(labels[2]).toMatch(/^Pintura/);
    expect(document.body.textContent).not.toMatch(/order-|veh-00|inc-001/);
  });

  it('links an order with an Idempotency-Key and shows it with its workshop', async () => {
    const { fake } = open();
    await screen.findByText('Sin órdenes vinculadas');
    press('Vincular orden');
    await pick('order-1');
    await pick('');
    await submitLink();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Elige la orden que vas a vincular.',
    );
    await pick('order-1');
    await submitLink();
    expect(await screen.findByText('Orden vinculada.')).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Órdenes vinculadas' });
    expect(list).toHaveTextContent('Cambio de defensa');
    expect(list).toHaveTextContent('Taller: Taller Central');
    expect(list).toHaveTextContent('Programada');
    expect(fake.calls.filter((call) => call === 'repairs.link')).toHaveLength(1);
    expect(document.body.textContent).not.toMatch(/order-1|link-1/);
  });

  it('creates a corrective order and links it: two calls, and a failed link retries only the link', async () => {
    const { fake } = open(review(), { permissions: ADMIN });
    await screen.findByText('Sin órdenes vinculadas');
    press('Vincular orden');
    const form = await screen.findByRole('form', { name: 'Crear orden correctiva' });
    expect(within(form).getByLabelText(/Descripción de la falla/)).toHaveValue(
      'Reparación del siniestro SIN-2026-000001',
    );
    fake.failNext('repairs.link', 500);
    fireEvent.click(within(form).getByRole('button', { name: 'Crear orden y vincular' }));
    expect(
      await screen.findByText(/La orden se creó, pero no pudimos vincularla/),
    ).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Vincular orden creada' }));
    expect(await screen.findByText('Orden creada y vinculada.')).toBeInTheDocument();
    expect(fake.calls.filter((call) => call === 'orders.createCorrective')).toHaveLength(1);
    expect(fake.calls.filter((call) => call === 'repairs.link')).toHaveLength(2);
    expect(await screen.findByRole('list', { name: 'Órdenes vinculadas' })).toHaveTextContent(
      'Reparación del siniestro SIN-2026-000001',
    );
  });

  it('keeps the created order when the dialog is closed and reopened: the next submit only links', async () => {
    const { fake } = open(review(), { permissions: ADMIN });
    await screen.findByText('Sin órdenes vinculadas');
    press('Vincular orden');
    const form = await screen.findByRole('form', { name: 'Crear orden correctiva' });
    fake.failNext('repairs.link', 500);
    fireEvent.click(within(form).getByRole('button', { name: 'Crear orden y vincular' }));
    await screen.findByText(/La orden se creó, pero no pudimos vincularla/);
    press('Cerrar');
    expect(screen.queryByRole('form', { name: 'Crear orden correctiva' })).not.toBeInTheDocument();
    press('Vincular orden');
    const again = await screen.findByRole('form', { name: 'Crear orden correctiva' });
    fireEvent.click(within(again).getByRole('button', { name: 'Vincular orden creada' }));
    expect(await screen.findByText('Orden creada y vinculada.')).toBeInTheDocument();
    expect(fake.calls.filter((call) => call === 'orders.createCorrective')).toHaveLength(1);
  });

  it('asks for the description before creating anything', async () => {
    const { fake } = open();
    await screen.findByText('Sin órdenes vinculadas');
    press('Vincular orden');
    const form = await screen.findByRole('form', { name: 'Crear orden correctiva' });
    fireEvent.change(within(form).getByLabelText(/Descripción de la falla/), {
      target: { value: ' ' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Crear orden y vincular' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('Describe la falla');
    expect(fake.calls).not.toContain('orders.createCorrective');
  });

  it('says what is missing when the caller cannot list or register orders', async () => {
    const { fake } = open(review(), { permissions: ['incidents:view', 'incidents:edit'] });
    await screen.findByText('Sin órdenes vinculadas');
    press('Vincular orden');
    expect(await screen.findByText(/hace falta poder consultar mantenimiento/)).toBeInTheDocument();
    expect(screen.getByText(/requiere permiso de creación en mantenimiento/)).toBeInTheDocument();
    expect(fake.calls).not.toContain('orders.list');
  });

  it('explains when no order is left to link', async () => {
    open(review(), {}, []);
    await screen.findByText('Sin órdenes vinculadas');
    press('Vincular orden');
    expect(
      await screen.findByText(/No hay órdenes correctivas de este vehículo por vincular/),
    ).toBeInTheDocument();
  });

  it('turns the refusals of the server into plain instructions', async () => {
    const { fake } = open();
    await screen.findByText('Sin órdenes vinculadas');
    press('Vincular orden');
    await pick('order-1');
    fake.failNext('repairs.link', 409, 'duplicate');
    await submitLink();
    expect(
      await screen.findByText('Esa orden ya está vinculada a un siniestro.'),
    ).toBeInTheDocument();
  });

  it('keeps the form and offers the reload when the case changed under the link', async () => {
    const { fake } = open();
    await screen.findByText('Sin órdenes vinculadas');
    press('Vincular orden');
    await pick('order-2');
    fake.changeExternally('inc-001', { description: 'Otro cambio' });
    await submitLink();
    expect(await screen.findByText(/El caso cambió mientras lo editabas/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Orden correctiva del vehículo/)).toHaveValue('order-2');
    fireEvent.click(screen.getByRole('button', { name: 'Recargar' }));
    await waitFor(() =>
      expect(fake.calls.filter((call) => call === 'get').length).toBeGreaterThan(1),
    );
    expect(screen.getByLabelText(/Orden correctiva del vehículo/)).toHaveValue('order-2');
  });

  it('unlinks after a confirmation, and says why the only order of a repair stays', async () => {
    const { fake } = open(review({ status: 'repair', version: 6 }));
    await screen.findByText('Sin órdenes vinculadas');
    press('Vincular orden');
    await pick('order-1');
    await submitLink();
    await screen.findByText('Orden vinculada.');
    fireEvent.click(await screen.findByRole('button', { name: 'Desvincular Cambio de defensa' }));
    let dialog = await screen.findByRole('dialog', { name: 'Desvincular orden' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Desvincular' }));
    expect(
      await within(dialog).findByText(/lo que sostiene el paso a reparación/),
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    expect(screen.getByRole('list', { name: 'Órdenes vinculadas' })).toBeInTheDocument();

    // Another order keeps the requirement, so the first can leave.
    press('Vincular orden');
    await pick('order-2');
    await submitLink();
    await waitFor(() =>
      expect(
        screen.getAllByRole('listitem').filter((item) => /Pintura/.test(item.textContent ?? '')),
      ).not.toHaveLength(0),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Desvincular Cambio de defensa' }));
    dialog = await screen.findByRole('dialog', { name: 'Desvincular orden' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Desvincular' }));
    expect(await screen.findByText('Orden desvinculada.')).toBeInTheDocument();
    expect(fake.calls.filter((call) => call === 'repairs.unlink')).toHaveLength(2);
  });

  it('reloads the case when an unlink finds it changed, with no dead-end message', async () => {
    const { fake } = open();
    await screen.findByText('Sin órdenes vinculadas');
    press('Vincular orden');
    await pick('order-1');
    await submitLink();
    await screen.findByText('Orden vinculada.');
    fireEvent.click(await screen.findByRole('button', { name: 'Desvincular Cambio de defensa' }));
    const dialog = await screen.findByRole('dialog', { name: 'Desvincular orden' });
    fake.failNext('repairs.unlink', 409, 'stale_version');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Desvincular' }));
    expect(await within(dialog).findByText(/ya lo actualizamos/)).toBeInTheDocument();
  });

  it('shows no buttons to a reader, nor in a draft or a closed case', async () => {
    const { unmount } = open(review(), { permissions: VIEWER });
    await screen.findByText('Sin órdenes vinculadas');
    expect(screen.queryByRole('button', { name: 'Vincular orden' })).toBeNull();
    expect(screen.getByText('Cuando se vincule una orden aparecerá aquí.')).toBeInTheDocument();
    unmount();
    open(review({ status: 'closed', version: 9, editableFields: [] }), { permissions: ADMIN });
    await screen.findByText('Sin órdenes vinculadas');
    expect(screen.queryByRole('button', { name: 'Vincular orden' })).toBeNull();
    expect(screen.queryByRole('link', { name: /Subir un presupuesto/ })).toBeNull();
  });

  it('lists the budget with its review state and never counts one still in review', async () => {
    const { fake } = open(review(), { permissions: MANAGER });
    await screen.findByText('Sin presupuesto.');
    expect(screen.getByRole('link', { name: 'Subir un presupuesto en Evidencia' })).toHaveAttribute(
      'href',
      '/incidents/inc-001/evidence',
    );
    await fake.ports.evidence.upload(
      'inc-001',
      {
        version: 4,
        category: 'budget',
        stage: 'workshop',
        name: 'presupuesto.pdf',
        contentType: 'application/pdf',
        contentBase64: 'AAAA',
      },
      'k1',
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Evidencia' }));
    fireEvent.click(await screen.findByRole('tab', { name: 'Reparación' }));
    const list = await screen.findByRole('list', { name: 'Presupuestos' });
    expect(list).toHaveTextContent('presupuesto.pdf');
    expect(list).toHaveTextContent('En revisión: aún no cuenta como evidencia');
  });

  it('retries a failed first load', async () => {
    open(review(), { prepare: (fake) => fake.failNext('repairs.list', 500) });
    fireEvent.click(await screen.findByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByText('Sin órdenes vinculadas')).toBeInTheDocument();
  });

  it('lets the next steps pass to repair once an order is linked', async () => {
    open(review());
    await screen.findByText('Sin órdenes vinculadas');
    expect(await screen.findByText(/Pasar a reparación: Vincula una orden/)).toBeInTheDocument();
    press('Vincular orden');
    await pick('order-1');
    await submitLink();
    await screen.findByText('Orden vinculada.');
    await waitFor(() =>
      expect(screen.queryByText(/Pasar a reparación: Vincula una orden/)).toBeNull(),
    );
  });
});
