import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { baseOrder, createFakeMaintenancePorts } from './fakePorts';
import { MaintenanceSettingsScreen, toMinorUnits } from './MaintenanceSettingsScreen';
import { ADMIN, EDITOR, VIEWER, renderView, violations } from './testing';
import { WorkOrderDetail } from './WorkOrderDetail';

const inProgress = () =>
  baseOrder({
    status: 'in_progress',
    version: 3,
    mechanicId: 'mec-1',
    tasks: [{ id: 't-1', description: 'Cambio de balatas' }],
  });

function view(permissions: string[], mechanicIds: string[] = []) {
  const fake = createFakeMaintenancePorts({
    viewCosts: permissions.includes('view_costs'),
    orders: [inProgress()],
  });
  const utils = renderView(
    <WorkOrderDetail
      ports={fake.ports}
      viewer={{ permissions, mechanicIds }}
      orderId="wo-1"
      onBack={vi.fn()}
      onExpired={vi.fn()}
    />,
  );
  return { ...utils, fake };
}
const pdf = (name: string) => new File(['%PDF-1.4'], name, { type: 'application/pdf' });
const upload = (label: string, file: File) =>
  fireEvent.change(screen.getByLabelText(label), { target: { files: [file] } });
const press = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));

describe('evidence and invoices in the order detail (G3 H3)', () => {
  it('labels the missing evidence, lets a file count only once it is saved, then completes', async () => {
    const { container, fake } = view(ADMIN);
    await fake.ports.settings.save({
      version: 0,
      expiryWindowDays: 30,
      recipientRoles: ['admin'],
      maintenanceEvidence: 'evidence_invoice',
    });
    await screen.findByRole('heading', { name: 'Evidencia y facturas' });
    expect(await violations(container)).toEqual([]);
    press('Registrar término');
    fireEvent.change(screen.getByLabelText('Fecha real del servicio'), {
      target: { value: '2026-10-12' },
    });
    fireEvent.change(screen.getByLabelText('Kilometraje del servicio'), {
      target: { value: '15200' },
    });
    const complete = () =>
      fireEvent.click(
        within(screen.getByRole('form', { name: 'Registrar término' })).getByRole('button', {
          name: 'Registrar término',
        }),
      );
    complete();
    const panel = await screen.findByRole('complementary', { name: 'Falta para continuar' });
    expect(
      within(panel).getByText('Sube al menos una evidencia del trabajo (foto o documento).'),
    ).toBeInTheDocument();
    expect(within(panel).getByText('Sube la factura del trabajo.')).toBeInTheDocument();

    upload('Subir evidencia (foto o PDF)', pdf('frenos.pdf'));
    await screen.findByText(/frenos\.pdf · En revisión/);
    upload('Subir factura (PDF o imagen)', pdf('factura.pdf'));
    await screen.findByText(/factura\.pdf · En revisión/);
    expect(screen.queryByRole('button', { name: 'Descargar frenos.pdf' })).toBeNull();

    fake.releaseFiles();
    press('Quitar factura.pdf');
    await waitFor(() => expect(screen.queryByText(/factura\.pdf/)).toBeNull());
    upload('Subir factura (PDF o imagen)', pdf('factura-2.pdf'));
    await screen.findByText(/factura-2\.pdf · En revisión/);
    fake.releaseFiles();
    // The form keeps its fields after a refusal: send it again.
    complete();
    await screen.findByLabelText('Estado: Terminada');
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const save = vi.fn(() => 'blob:x');
    Object.assign(URL, { createObjectURL: save, revokeObjectURL: vi.fn() });
    press('Descargar frenos.pdf');
    await waitFor(() => expect(save).toHaveBeenCalled());
  });

  it('lets the assigned mechanic add evidence but never an invoice, and nobody once closed', async () => {
    const { fake, unmount } = view(VIEWER, ['mec-1']);
    await screen.findByLabelText('Subir evidencia (foto o PDF)');
    expect(screen.queryByLabelText('Subir factura (PDF o imagen)')).toBeNull();
    upload('Subir evidencia (foto o PDF)', pdf('foto.pdf'));
    await screen.findByText(/foto\.pdf ·/);
    unmount();

    const closed = createFakeMaintenancePorts({
      viewCosts: true,
      orders: [baseOrder({ status: 'closed', version: 9 })],
    });
    renderView(
      <WorkOrderDetail
        ports={closed.ports}
        viewer={{ permissions: ADMIN, mechanicIds: [] }}
        orderId="wo-1"
        onBack={vi.fn()}
        onExpired={vi.fn()}
      />,
    );
    await screen.findByText('Aún no hay evidencia.');
    expect(screen.queryByLabelText('Subir evidencia (foto o PDF)')).toBeNull();
    expect(fake.state.calls).toEqual([]);
  });

  it('keeps the viewer and the editor honest: editors upload evidence, invoices need view_costs', async () => {
    view(EDITOR);
    await screen.findByLabelText('Subir evidencia (foto o PDF)');
    expect(screen.queryByLabelText('Subir factura (PDF o imagen)')).toBeNull();
  });

  it('rejects a file over the size limit before sending it', async () => {
    const { fake } = view(ADMIN);
    const spy = vi.spyOn(fake.ports.orders.files, 'upload');
    await screen.findByLabelText('Subir evidencia (foto o PDF)');
    const big = new File(['x'], 'grande.pdf', { type: 'application/pdf' });
    Object.defineProperty(big, 'size', { value: 9 * 1024 * 1024 });
    upload('Subir evidencia (foto o PDF)', big);
    await screen.findByText('El archivo supera el máximo de 8 MB.');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('maintenance settings screen (G3 H3, D20, M4)', () => {
  it('converts amounts to exact minor units', () => {
    expect(toMinorUnits('5000')).toBe('500000');
    expect(toMinorUnits('12.5')).toBe('1250');
    expect(toMinorUnits('0.05')).toBe('5');
    expect(toMinorUnits('1,5')).toBeNull();
    expect(toMinorUnits('-1')).toBeNull();
  });

  it('saves the evidence requirement, the threshold and the zone, and clears the threshold', async () => {
    const fake = createFakeMaintenancePorts();
    const { container } = renderView(
      <MaintenanceSettingsScreen ports={fake.ports} onExpired={vi.fn()} />,
    );
    await screen.findByRole('form', { name: 'Configuración de mantenimiento' });
    expect(await violations(container)).toEqual([]);
    fireEvent.mouseDown(screen.getByLabelText('Archivos requeridos'));
    fireEvent.click(await screen.findByRole('option', { name: 'Evidencia y factura' }));
    fireEvent.change(screen.getByLabelText('Umbral de cierre costoso (opcional)'), {
      target: { value: '5000.50' },
    });
    fireEvent.change(screen.getByLabelText('Zona horaria de la empresa'), {
      target: { value: 'America/Mexico_City' },
    });
    press('Guardar configuración');
    await screen.findByText('Configuración guardada.');
    expect((await fake.ports.settings.get()).ok && (await fake.ports.settings.get())).toMatchObject(
      {
        value: {
          maintenanceEvidence: 'evidence_invoice',
          closeCostThreshold: { amountMinor: '500050', currency: 'MXN' },
          timeZone: 'America/Mexico_City',
          version: 1,
        },
      },
    );
    fireEvent.change(screen.getByLabelText('Umbral de cierre costoso (opcional)'), {
      target: { value: '' },
    });
    press('Guardar configuración');
    await waitFor(async () => {
      const saved = await fake.ports.settings.get();
      expect(saved.ok && saved.value.closeCostThreshold).toBeNull();
    });
  });

  it('blocks an invalid amount and reports a refused save', async () => {
    const fake = createFakeMaintenancePorts();
    const save = vi.spyOn(fake.ports.settings, 'save');
    renderView(<MaintenanceSettingsScreen ports={fake.ports} onExpired={vi.fn()} />);
    await screen.findByRole('form', { name: 'Configuración de mantenimiento' });
    fireEvent.change(screen.getByLabelText('Umbral de cierre costoso (opcional)'), {
      target: { value: 'mucho' },
    });
    expect(screen.getByRole('button', { name: 'Guardar configuración' })).toBeDisabled();
    expect(save).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Umbral de cierre costoso (opcional)'), {
      target: { value: '' },
    });
    save.mockResolvedValueOnce({
      ok: false,
      error: { status: 400, code: 'invalid_input', message: 'x', correlationId: 'c' },
    });
    press('Guardar configuración');
    await screen.findByText(/la zona horaria debe ser válida/);
  });
});
