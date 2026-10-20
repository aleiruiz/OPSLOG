import { describe, expect, it } from 'vitest';
import { renderApp, screen, waitFor } from './test/utils';

/** MVP-INTEGRATE: the M5 modules are mounted in the detail screens and each entry follows its permission. */
describe('M5 wiring in the detail screens', () => {
  it('mounts «Seguir», the report links and the audit history on a vehicle for an administrator', async () => {
    await renderApp({ path: '/flota/vehiculos/veh-001' });
    await screen.findByRole('heading', { name: /^Vehículo ECO-/, level: 1 });
    expect(await screen.findByRole('button', { name: /Seguir/ })).toBeInTheDocument();
    const sheet = screen.getByRole('link', { name: 'Ficha PDF' });
    expect(sheet.getAttribute('href')).toMatch(/reporte=vehicle_sheet&vehicle=ECO-001$/);
    expect(
      screen.getByRole('link', { name: 'Historial del vehículo' }).getAttribute('href'),
    ).toMatch(/reporte=vehicle_history&vehicle=ECO-001$/);
    expect(
      await screen.findByRole('heading', { name: 'Historial de auditoría', level: 2 }),
    ).toBeInTheDocument();
  });

  it('shows none of them without export or view_audit', async () => {
    await renderApp({ path: '/flota/vehiculos/veh-001', account: 'viewer' });
    await screen.findByRole('heading', { name: /^Vehículo ECO-/, level: 1 });
    expect(screen.queryByRole('link', { name: 'Ficha PDF' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Historial del vehículo' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Historial de auditoría' })).toBeNull();
    expect(screen.queryByText(/sin permiso|no tienes permiso/i)).toBeNull();
  });

  it('adds the «Historial» tab, «Seguir» and the sheet to an incident only with the right grants', async () => {
    const admin = await renderApp({ path: '/incidents/inc-002' });
    await screen.findByRole('heading', { name: 'SIN-2026-000002', level: 1 });
    expect(screen.getByRole('tab', { name: 'Historial' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /Seguir/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ficha PDF' }).getAttribute('href')).toContain(
      'reporte=incident_sheet&folio=SIN-2026-000002',
    );
    admin.unmount();

    await renderApp({ path: '/incidents/inc-002', account: 'dispatch' });
    await screen.findByRole('heading', { name: 'SIN-2026-000002', level: 1 });
    expect(screen.queryByRole('tab', { name: 'Historial' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Ficha PDF' })).toBeNull();
  });

  it('offers «Exportar» in the audit screen, carrying the filters to the audit_log report', async () => {
    await renderApp({ path: '/analisis/auditoria' });
    const link = await screen.findByRole('link', { name: 'Exportar' });
    expect(link.getAttribute('href')).toBe('/analisis/reportes?reporte=audit_log');
  });

  it('opens a report with the filters named in the address', async () => {
    await renderApp({ path: '/analisis/reportes?reporte=vehicle_sheet&vehicle=ECO-001' });
    const field = await screen.findByLabelText(/Vehículo/);
    await waitFor(() => expect(field).toHaveValue('ECO-001'));
  });
});
