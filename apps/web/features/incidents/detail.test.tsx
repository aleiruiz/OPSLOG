import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { baseIncident, completeEvent } from './fakePorts';
import {
  ADMIN,
  APPROVER,
  FLEET_EDITOR,
  MANAGER,
  VIEWER,
  renderIncident,
  violations,
  RoutedDetail,
} from './testing';

const press = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));
const fill = (label: string | RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const by = { id: 'user-me', displayName: 'Tú' };

const reported = () =>
  completeEvent({
    status: 'reported',
    version: 2,
    reportedAt: '2026-10-12T16:00:00.000Z',
    reportedBy: by,
  });

function show(
  incident = reported(),
  permissions: readonly string[] = ADMIN,
  extra: Parameters<typeof renderIncident>[1] = {},
) {
  return renderIncident(<RoutedDetail />, {
    ...extra,
    permissions,
    path: `/incidents/${incident.id}`,
    options: { incidents: [incident], ...extra.options },
  });
}

describe('case page', () => {
  it('shows the case by name, never by technical id, and is accessible', async () => {
    const { container } = show();
    expect(
      await screen.findByRole('heading', { name: 'SIN-2026-000001', level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByText('Reportado')).toBeInTheDocument();
    expect(screen.getByText('Colisión · ECO-001 · ABC-123')).toBeInTheDocument();
    expect(screen.getByText('12/10/2026 09:30')).toBeInTheDocument();
    expect(await screen.findByText('Ana Pérez')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/inc-001|veh-001|emp-001|user-me/);
    expect(await violations(container)).toEqual([]);
  });

  it('changes tab through the address and renders every tab', async () => {
    const { container } = show();
    await screen.findByRole('heading', { level: 1 });
    for (const [name, text] of [
      ['Terceros', /Aún no hay terceros|Terceros/],
      ['Evidencia', /Evidencia|archivos/],
      ['Seguro', /aseguradora|Seguro/i],
      ['Timeline', /Timeline|Aún no|movimientos/i],
    ] as const) {
      fireEvent.click(screen.getByRole('tab', { name }));
      expect(window.location.pathname).toMatch(new RegExp(`/incidents/inc-001/`));
      await waitFor(() =>
        expect(screen.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true'),
      );
      expect(await violations(container)).toEqual([]);
      void text;
    }
  });

  it('answers a missing or foreign case with the same neutral not-found screen', async () => {
    renderIncident(<RoutedDetail />, { path: '/incidents/nope' });
    expect(await screen.findByText('No encontramos este siniestro')).toBeInTheDocument();
    expect(screen.getByText(/no exista o que no tengas acceso/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Siniestros' })).toHaveAttribute('href', '/incidents');
  });

  it('hands a 401 to the shared session handling', async () => {
    const { onExpired } = renderIncident(<RoutedDetail />, {
      path: '/incidents/inc-001',
      options: { incidents: [reported()] },
      prepare: (fake) => fake.failNext('get', 401, 'unauthorized'),
    });
    await waitFor(() => expect(onExpired).toHaveBeenCalled());
  });

  it('offers a retry when the first load fails, and recovers', async () => {
    renderIncident(<RoutedDetail />, {
      path: '/incidents/inc-001',
      options: { incidents: [reported()] },
      prepare: (fake) => fake.failNext('get', 500),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByRole('heading', { name: 'SIN-2026-000001' })).toBeInTheDocument();
  });

  it('shows no permission when the server refuses the case', async () => {
    renderIncident(<RoutedDetail />, {
      path: '/incidents/inc-001',
      options: { incidents: [reported()] },
      prepare: (fake) => fake.failNext('get', 403, 'forbidden'),
    });
    expect(await screen.findByText('No tienes acceso')).toBeInTheDocument();
  });
});

describe('next step', () => {
  it('lists what a draft still lacks in plain Spanish and reports once it is complete', async () => {
    const draft = baseIncident({ status: 'draft', version: 1 });
    show(draft, ADMIN);
    const panel = await screen.findByRole('complementary', { name: 'Falta para continuar' });
    expect(
      within(panel).getByText('Reportar: Indica la fecha y hora del evento.'),
    ).toBeInTheDocument();
    expect(within(panel).getByText(/Describe lo que ocurrió/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/occurred_at|photo_or_justification/);
    press('Reportar');
    expect(await screen.findByRole('alert')).toHaveTextContent('Faltan requisitos para continuar');
  });

  it('reports a complete draft', async () => {
    show(completeEvent({ status: 'draft' }));
    await screen.findByRole('region', { name: 'Acciones del caso' });
    press('Reportar');
    expect(await screen.findByText('Reportar: listo.')).toBeInTheDocument();
    expect(await screen.findByText('Reportado')).toBeInTheDocument();
  });

  it('gives a view-only actor no buttons and says why', async () => {
    show(reported(), VIEWER);
    expect(await screen.findByText(/Solo puedes consultar este caso/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Asignar|Iniciar|Cancelar|Reportar/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Editar datos del evento' })).toBeNull();
    for (const name of ['Terceros', 'Evidencia', 'Seguro']) {
      fireEvent.click(screen.getByRole('tab', { name }));
      await waitFor(() =>
        expect(screen.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true'),
      );
      expect(
        screen.queryByRole('button', { name: /Agregar|Subir|Quitar|Guardar|Tomar/ }),
      ).toBeNull();
    }
  });

  it('gives a fleet editor with generic grants only the view of the case', async () => {
    show(reported(), FLEET_EDITOR);
    expect(await screen.findByText(/Solo puedes consultar este caso/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Editar datos del evento' })).toBeNull();
  });

  it('assigns a responsible and walks the case forward with a keyed command', async () => {
    const { fake } = show(reported());
    await screen.findByRole('region', { name: 'Acciones del caso' });
    press('Asignar responsable');
    const form = screen.getByRole('form', { name: 'Asignar responsable' });
    expect(within(form).getByRole('button', { name: 'Asignar' })).toBeDisabled();
    fill(/Persona responsable/, 'user-2');
    fireEvent.click(within(form).getByRole('button', { name: 'Asignar' }));
    expect(await screen.findByText('Asignar responsable: listo.')).toBeInTheDocument();
    expect(await screen.findByText('Responsable asignado')).toBeInTheDocument();
    press('Iniciar revisión');
    expect(await screen.findByText('En revisión')).toBeInTheDocument();
    expect(fake.stored('inc-001')?.status).toBe('under_review');
    // The cancel form can be opened and closed without sending anything.
    press('Cancelar caso');
    const dialog = await screen.findByRole('region', { name: 'Cancelar caso' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Cancelar caso' })).toBeNull());
  });

  it('closes the assign form without sending', async () => {
    show(reported());
    await screen.findByRole('region', { name: 'Acciones del caso' });
    press('Asignar responsable');
    fireEvent.click(
      within(screen.getByRole('form', { name: 'Asignar responsable' })).getByRole('button', {
        name: 'Cancelar',
      }),
    );
    expect(screen.queryByRole('form', { name: 'Asignar responsable' })).toBeNull();
  });

  it('stores the rejection reason on the insurance data, then asks for the missing letter', async () => {
    const inProcess = completeEvent({
      status: 'insurance_process',
      version: 5,
      responsible: { id: 'user-2', displayName: 'Responsable' },
    });
    const { fake } = show(inProcess);
    await screen.findByRole('region', { name: 'Acciones del caso' });
    press('Registrar rechazo');
    fill(/Motivo del rechazo/, 'Póliza vencida');
    fireEvent.click(
      within(screen.getByRole('region', { name: 'Registrar rechazo' })).getByRole('button', {
        name: 'Registrar rechazo',
      }),
    );
    await waitFor(() =>
      expect(fake.stored('inc-001')?.insurance.rejectionReason).toBe('Póliza vencida'),
    );
    const panel = await screen.findByRole('complementary', { name: 'Falta para continuar' });
    expect(within(panel).getByText(/Sube la carta de rechazo/)).toBeInTheDocument();
    // The stored reason moved the case to a new version; the next write must use it.
    press('Editar datos del evento');
    fill('Descripción', 'Texto corregido después del rechazo');
    press('Guardar cambios');
    expect(await screen.findByText('Cambios guardados.')).toBeInTheDocument();
  });

  it('offers the supervisor approval and hides the command it blocks (D20)', async () => {
    const resolved = completeEvent({
      status: 'resolved',
      version: 8,
      resolution: {
        ...baseIncident().resolution,
        resolutionSummary: 'Reparado',
        vehicleStatusDecision: 'active',
      },
    });
    const options = { thresholdConfigured: true, approvalRequired: true };
    const manager = show(resolved, MANAGER, { options });
    expect(
      await screen.findByText(/necesita la aprobación de una persona supervisora/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cerrar caso' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Aprobar cierre' })).toBeNull();
    expect(document.body.textContent).not.toMatch(/\$|MXN|umbral/i);
    manager.unmount();
    show(resolved, APPROVER, { options });
    fireEvent.click(await screen.findByRole('button', { name: 'Aprobar cierre' }));
    expect(await screen.findByText('Aprobar cierre: listo.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Aprobar cierre' })).toBeNull();
  });

  it('explains a closed case and reopens it only with a reason', async () => {
    const closed = completeEvent({ status: 'closed', version: 9, editableFields: [] });
    const { fake } = show(closed, ADMIN);
    expect(await screen.findByText(/Caso cerrado: es historial/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Editar datos del evento' })).toBeNull();
    press('Reabrir caso');
    const form = await screen.findByRole('region', { name: 'Reabrir caso' });
    expect(within(form).getByRole('button', { name: 'Reabrir caso' })).toBeDisabled();
    fill(/Motivo de la reapertura/, 'El taller encontró más daño');
    fireEvent.click(within(form).getByRole('button', { name: 'Reabrir caso' }));
    expect(await screen.findByText('Reabierto')).toBeInTheDocument();
    expect(fake.stored('inc-001')?.status).toBe('reopened');
  });

  it('keeps unsent fields and explains a conflict, and reloads without losing them', async () => {
    const { fake } = show(reported());
    await screen.findByRole('region', { name: 'Acciones del caso' });
    const update = vi.spyOn(fake.ports, 'update');
    press('Editar datos del evento');
    fill('Descripción', 'Texto que sigo escribiendo');
    fake.changeExternally('inc-001', { severity: 'high' });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('El caso cambió mientras lo editabas');
    fireEvent.click(within(alert).getByRole('button', { name: 'Recargar' }));
    await waitFor(() =>
      expect(screen.getByLabelText('Descripción')).toHaveValue('Texto que sigo escribiendo'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    expect(update.mock.calls[1]?.[1]).toEqual({
      version: 3,
      description: 'Texto que sigo escribiendo',
    });
    expect(await screen.findByText('Cambios guardados.')).toBeInTheDocument();
  });

  it('says so when the next steps cannot be loaded and retries', async () => {
    show(reported(), ADMIN, {
      prepare: (fake) => fake.failNext('nextSteps', 500),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByRole('button', { name: 'Asignar responsable' })).toBeInTheDocument();
  });

  it('runs the rejection, appeal and assumption approval (US-033) with the reasons stored first', async () => {
    const rejected = completeEvent({
      status: 'insurance_rejected',
      version: 10,
      responsible: { id: 'user-2', displayName: 'Responsable' },
      insurance: {
        ...baseIncident().insurance,
        rejectionReason: 'Póliza vencida',
        costAssumed: true,
      },
    });
    const options = { thresholdConfigured: true, approvalRequired: true };
    const approver = show(rejected, APPROVER, { options });
    fireEvent.click(await screen.findByRole('button', { name: 'Aprobar asunción del costo' }));
    expect(await screen.findByText('Aprobar asunción del costo: listo.')).toBeInTheDocument();
    expect(approver.fake.stored('inc-001')?.insurance.assumptionApproval).not.toBeNull();
    approver.unmount();
    const manager = show(rejected, ADMIN, { options });
    await screen.findByRole('region', { name: 'Acciones del caso' });
    // The command that would carry the cost waits for the approval; the appeal is still possible.
    expect(screen.queryByRole('button', { name: 'Pasar a reparación' })).toBeNull();
    press('Apelar');
    fill(/Nota de la apelación/, 'La carta no aplica a este vehículo');
    fireEvent.click(
      within(screen.getByRole('region', { name: 'Apelar' })).getByRole('button', {
        name: 'Apelar',
      }),
    );
    expect(await screen.findByText('Apelar: listo.')).toBeInTheDocument();
    expect(manager.fake.stored('inc-001')?.insurance.appealNote).toBe(
      'La carta no aplica a este vehículo',
    );
    expect(await screen.findByText('Con la aseguradora')).toBeInTheDocument();
  });

  it('explains a conflict on a command and offers to reload', async () => {
    const { fake } = show(reported());
    await screen.findByRole('region', { name: 'Acciones del caso' });
    fake.changeExternally('inc-001', { severity: 'high' });
    fake.failNext('transition', 409, 'stale_version');
    press('Cancelar caso');
    fill(/Motivo de la cancelación/, 'Duplicado');
    fireEvent.click(
      within(screen.getByRole('region', { name: 'Cancelar caso' })).getByRole('button', {
        name: 'Cancelar caso',
      }),
    );
    const banner = await screen.findAllByText(/El caso cambió mientras lo editabas/);
    expect(banner.length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole('button', { name: 'Recargar' })[0] as HTMLElement);
    await waitFor(() =>
      expect(screen.queryAllByText(/El caso cambió mientras lo editabas/)).toHaveLength(0),
    );
  });

  it('expires the session when a command answers 401', async () => {
    const { fake, onExpired } = show(completeEvent({ status: 'draft' }));
    await screen.findByRole('region', { name: 'Acciones del caso' });
    fake.failNext('transition', 401, 'unauthorized');
    press('Reportar');
    await waitFor(() => expect(onExpired).toHaveBeenCalled());
  });

  it('explains a refused command without echoing the server', async () => {
    const { fake } = show(reported());
    await screen.findByRole('region', { name: 'Acciones del caso' });
    fake.failNext('transition', 500);
    press('Iniciar revisión');
    expect((await screen.findAllByRole('alert'))[0]).toHaveTextContent(
      'No pudimos completar la acción',
    );
  });
});
