import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { baseIncident, completeEvent } from './fakePorts';
import { IncidentWizard } from './IncidentWizard';
import { ADMIN, REPORTER, renderIncident, violations } from './testing';

const press = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));
const fill = (label: string | RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('new incident wizard', () => {
  it('creates the draft once even with a double click, then resumes from the address', async () => {
    const { fake, container } = renderIncident(<IncidentWizard />, {
      permissions: REPORTER,
      path: '/incidents/new',
    });
    expect(await screen.findByRole('heading', { name: 'Nuevo siniestro' })).toBeInTheDocument();
    expect(await violations(container)).toEqual([]);
    press('Crear');
    // Nothing chosen yet: nothing is sent.
    expect(await screen.findByRole('alert')).toHaveTextContent('Elige el tipo de siniestro');
    fill(/Tipo de siniestro/, 'collision');
    fill(/Vehículo/, 'veh-002');
    fill('Descripción', 'Golpe en estacionamiento');
    const create = vi.spyOn(fake.ports, 'create');
    const button = screen.getByRole('button', { name: 'Crear' });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(window.location.search).toBe('?borrador=inc-new-1&paso=2'));
    expect(create.mock.calls.length).toBeLessThanOrEqual(2);
    if (create.mock.calls.length === 2)
      expect(create.mock.calls[0]?.[1]).toBe(create.mock.calls[1]?.[1]);
    expect(fake.stored('inc-new-2')).toBeUndefined();
    expect(await screen.findByText('Borrador guardado.')).toBeInTheDocument();
    expect(screen.getByText('Borrador SIN-2026-000901')).toBeInTheDocument();
  });

  it('walks every step of an existing draft and reports it when nothing is missing', async () => {
    const draft = completeEvent({ id: 'inc-9', folio: 'SIN-2026-000009', status: 'draft' });
    const { fake } = renderIncident(<IncidentWizard />, {
      path: '/incidents/new?borrador=inc-9&paso=1',
      options: { incidents: [draft] },
    });
    expect(await screen.findByRole('form', { name: 'Datos del evento' })).toBeInTheDocument();
    expect(screen.getByLabelText('Descripción')).toHaveValue('Golpe lateral al cambiar de carril.');
    // Nothing changed: continuing sends nothing.
    const update = vi.spyOn(fake.ports, 'update');
    press('Guardar y continuar');
    await waitFor(() => expect(window.location.search).toBe('?borrador=inc-9&paso=2'));
    expect(update).not.toHaveBeenCalled();
    expect(await screen.findByRole('form', { name: 'Conductor y póliza' })).toBeInTheDocument();
    fill('Conductor', 'emp-2');
    press('Guardar y continuar');
    await waitFor(() => expect(window.location.search).toBe('?borrador=inc-9&paso=3'));
    expect(update).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('button', { name: 'Continuar' })).toBeInTheDocument();
    press('Atrás');
    await waitFor(() => expect(window.location.search).toBe('?borrador=inc-9&paso=2'));
    fireEvent.click(await screen.findByRole('button', { name: 'Guardar y continuar' }));
    await waitFor(() => expect(window.location.search).toBe('?borrador=inc-9&paso=3'));
    press('Continuar');
    await waitFor(() => expect(window.location.search).toBe('?borrador=inc-9&paso=4'));
    expect(await screen.findByRole('form', { name: 'Justificación sin foto' })).toBeInTheDocument();
    press('Guardar y continuar');
    await waitFor(() => expect(window.location.search).toBe('?borrador=inc-9&paso=5'));
    expect(await screen.findByText('Listo para reportar')).toBeInTheDocument();
    press('Reportar');
    await waitFor(() => expect(window.location.pathname).toBe('/incidents/inc-9'));
    expect(fake.stored('inc-9')?.status).toBe('reported');
  });

  it('lists what is missing in the last step and keeps the draft', async () => {
    const draft = baseIncident({ id: 'inc-8', folio: 'SIN-2026-000008', status: 'draft' });
    renderIncident(<IncidentWizard />, {
      path: '/incidents/new?borrador=inc-8&paso=5',
      options: { incidents: [draft] },
    });
    const missing = await screen.findByRole('complementary', { name: 'Falta para reportar' });
    expect(within(missing).getByText(/Indica la fecha y hora del evento/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reportar' })).toBeDisabled();
    expect(document.body.textContent).not.toMatch(/occurred_at|inc-8/);
    press('Guardar borrador y salir');
    await waitFor(() => expect(window.location.pathname).toBe('/incidents/inc-8'));
  });

  it('goes back to a visited step from the stepper', async () => {
    const draft = completeEvent({ id: 'inc-7', status: 'draft' });
    renderIncident(<IncidentWizard />, {
      path: '/incidents/new?borrador=inc-7&paso=3',
      options: { incidents: [draft] },
    });
    await screen.findByRole('button', { name: 'Continuar' });
    // Steps already visited are links back; the next ones are reached with "Continuar".
    expect(screen.getByRole('button', { name: 'Evidencia' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Evento' }));
    await waitFor(() => expect(window.location.search).toBe('?borrador=inc-7&paso=1'));
  });

  it('answers a missing draft and a draft that was already reported', async () => {
    const first = renderIncident(<IncidentWizard />, {
      path: '/incidents/new?borrador=nope&paso=1',
    });
    expect(await screen.findByText('No encontramos este borrador')).toBeInTheDocument();
    first.unmount();
    renderIncident(<IncidentWizard />, {
      path: '/incidents/new?borrador=inc-6&paso=1',
      options: { incidents: [completeEvent({ id: 'inc-6', status: 'reported' })] },
    });
    expect(await screen.findByText('Este caso ya no es un borrador')).toBeInTheDocument();
    press('Ver siniestro');
    await waitFor(() => expect(window.location.pathname).toBe('/incidents/inc-6'));
  });

  it('explains a failed creation and keeps what was typed', async () => {
    const { fake } = renderIncident(<IncidentWizard />, {
      permissions: REPORTER,
      path: '/incidents/new',
      prepare: (f) => f.failNext('create', 500),
    });
    await screen.findByRole('form', { name: 'Datos del evento' });
    fill(/Tipo de siniestro/, 'collision');
    fill(/Vehículo/, 'veh-001');
    fill('Descripción', 'Texto largo');
    press('Crear');
    expect(await screen.findByRole('alert')).toHaveTextContent('No pudimos crear el borrador');
    expect(screen.getByLabelText('Descripción')).toHaveValue('Texto largo');
    press('Crear');
    await waitFor(() => expect(window.location.search).toContain('borrador='));
    void fake;
  });

  it('tells a reporter-less caller they cannot report from the last step', async () => {
    renderIncident(<IncidentWizard />, {
      permissions: ['incidents:view'],
      path: '/incidents/new?borrador=inc-5&paso=5',
      options: { incidents: [completeEvent({ id: 'inc-5', status: 'draft' })] },
    });
    expect(await screen.findByText(/No tienes permiso para reportar/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reportar' })).toBeNull();
  });

  it('shows the server refusal when reporting fails', async () => {
    const draft = completeEvent({ id: 'inc-4', status: 'draft' });
    const { fake } = renderIncident(<IncidentWizard />, {
      permissions: ADMIN,
      path: '/incidents/new?borrador=inc-4&paso=5',
      options: { incidents: [draft] },
    });
    await screen.findByText('Listo para reportar');
    fake.changeExternally('inc-4', { description: 'Otro lo cambió' });
    press('Reportar');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'El caso cambió mientras lo editabas',
    );
  });

  it('offers the drivers and policies that fit the event, and keeps a driver outside the list', async () => {
    const draft = completeEvent({ id: 'inc-3', status: 'draft' });
    const { fake } = renderIncident(<IncidentWizard />, {
      path: '/incidents/new?borrador=inc-3&paso=2',
      options: {
        incidents: [draft],
        suggestions: {
          drivers: [{ employeeId: 'emp-3', displayName: 'Carla Ruiz', type: 'principal' }],
          policies: [
            {
              policyId: 'pol-1',
              revision: 1,
              insurer: 'Aseguradora A',
              policyNumber: 'A-1',
              coverageType: 'full',
              startsOn: '2026-01-01',
              endsOn: '2026-12-31',
            },
          ],
          coverage: { status: 'multiple', alert: null },
        },
      },
    });
    await screen.findByRole('form', { name: 'Conductor y póliza' });
    const driver = await screen.findByRole('option', { name: 'Carla Ruiz · principal' });
    expect(driver).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Ana Pérez' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Luis Gómez · EMP-2' })).toBeInTheDocument();
    fill('Conductor', '');
    fill('Motivo si no hay conductor', 'Vehículo estacionado');
    fill('Póliza que cubría el día del evento', 'pol-1');
    const update = vi.spyOn(fake.ports, 'update');
    press('Guardar y continuar');
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0]?.[1]).toMatchObject({
      driverId: null,
      noDriverReason: 'Vehículo estacionado',
      policyId: 'pol-1',
    });
  });

  it('shows a conflict on a step and reloads keeping what was typed', async () => {
    const draft = completeEvent({ id: 'inc-2', status: 'draft' });
    const { fake } = renderIncident(<IncidentWizard />, {
      path: '/incidents/new?borrador=inc-2&paso=1',
      options: { incidents: [draft] },
    });
    await screen.findByRole('form', { name: 'Datos del evento' });
    fill('Ubicación', 'Calle nueva 5');
    fake.changeExternally('inc-2', { description: 'Cambio ajeno' });
    press('Guardar y continuar');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('El caso cambió mientras lo editabas');
    fireEvent.click(within(alert).getByRole('button', { name: 'Recargar' }));
    await waitFor(() => expect(screen.getByLabelText('Descripción')).toHaveValue('Cambio ajeno'));
    expect(screen.getByLabelText('Ubicación')).toHaveValue('Calle nueva 5');
  });
});
