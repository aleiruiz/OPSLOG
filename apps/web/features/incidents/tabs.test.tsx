import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { baseIncident, completeEvent } from './fakePorts';
import { EvidenceTab } from './EvidenceTab';
import { useIncident } from './useIncident';
import {
  ADMIN,
  MANAGER,
  RoutedDetail,
  VIEWER,
  renderIncident,
  violations,
  type View,
} from './testing';

const press = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));
const fill = (label: string | RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const open = (incident: ReturnType<typeof completeEvent>, tab: string, view: View = {}) =>
  renderIncident(<RoutedDetail />, {
    path: `/incidents/${incident.id}/${tab}`,
    ...view,
    options: { incidents: [incident], ...view.options },
  });
const review = () =>
  completeEvent({
    status: 'under_review',
    version: 4,
    responsible: { id: 'user-2', displayName: 'Responsable de flotilla 1' },
  });

describe('third parties', () => {
  it('adds, edits and removes a third party, naming each by kind and position', async () => {
    const { container } = open(review(), 'third-parties', {
      permissions: ADMIN,
      options: { viewPii: true },
    });
    expect(await screen.findByText('Sin terceros registrados')).toBeInTheDocument();
    press('Agregar tercero');
    fill('Nombre', 'Luis Gómez');
    press('Guardar nuevo tercero');
    expect(await screen.findByRole('alert')).toHaveTextContent('Elige el tipo de tercero');
    fill(/Tipo de tercero/, 'vehicle');
    fill('Nombre', 'Luis Gómez');
    fill('Placas', 'XYZ-987');
    fill('¿Hubo lesiones?', 'yes');
    press('Guardar nuevo tercero');
    const card = await screen.findByRole('listitem', { name: 'Vehículo 1' });
    expect(card).toHaveTextContent('Luis Gómez');
    expect(card).toHaveTextContent('XYZ-987');
    expect(await screen.findByText('Tercero agregado.')).toBeInTheDocument();
    expect(await violations(container)).toEqual([]);
    press('Editar Vehículo 1');
    fill('Contacto', '555-0100');
    press('Guardar tercero');
    expect(await screen.findByText('Tercero actualizado.')).toBeInTheDocument();
    expect(await screen.findByText('555-0100')).toBeInTheDocument();
    press('Retirar Vehículo 1');
    const dialog = await screen.findByRole('dialog', { name: 'Retirar tercero' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Retirar' }));
    expect(await screen.findByText('Sin terceros registrados')).toBeInTheDocument();
  });

  it('shows no identity without view_pii, and says so instead of drawing empty fields', async () => {
    const { fake } = open(review(), 'third-parties', {
      permissions: ADMIN,
      options: { viewPii: false },
    });
    await screen.findByText('Sin terceros registrados');
    press('Agregar tercero');
    expect(
      screen.getByText(/sin permiso para ver datos de identidad no lo volverás a ver/),
    ).toBeInTheDocument();
    fill(/Tipo de tercero/, 'person');
    fill('Nombre', 'Persona Secreta');
    fill('Contacto', '555-0000');
    press('Guardar nuevo tercero');
    const card = await screen.findByRole('listitem', { name: 'Persona 1' });
    expect(card).toHaveTextContent('Datos de identidad restringidos');
    expect(document.body.textContent).not.toMatch(/Persona Secreta|555-0000/);
    expect(screen.queryByText('Nombre')).toBeNull();
    void fake;
  });

  it('gives a read-only actor no buttons and a closed case no way to add', async () => {
    open(review(), 'third-parties', { permissions: VIEWER });
    await screen.findByText('Sin terceros registrados');
    expect(screen.queryByRole('button', { name: 'Agregar tercero' })).toBeNull();
    expect(screen.getByText('Cuando se registren terceros aparecerán aquí.')).toBeInTheDocument();
  });

  it('explains a failed removal and a failed load', async () => {
    const { fake } = open(review(), 'third-parties', { permissions: ADMIN });
    await screen.findByText('Sin terceros registrados');
    press('Agregar tercero');
    fill(/Tipo de tercero/, 'property');
    press('Guardar nuevo tercero');
    await screen.findByRole('listitem', { name: 'Propiedad 1' });
    press('Retirar Propiedad 1');
    fake.failNext('thirdParties.remove', 500);
    const dialog = await screen.findByRole('dialog', { name: 'Retirar tercero' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Retirar' }));
    expect(await within(dialog).findByText(/No pudimos retirar al tercero/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
  });

  it('reloads the case when a removal finds it changed, with no dead-end message', async () => {
    const { fake } = open(review(), 'third-parties', { permissions: ADMIN });
    await screen.findByText('Sin terceros registrados');
    press('Agregar tercero');
    fill(/Tipo de tercero/, 'property');
    press('Guardar nuevo tercero');
    await screen.findByRole('listitem', { name: 'Propiedad 1' });
    press('Retirar Propiedad 1');
    fake.failNext('thirdParties.remove', 409, 'stale_version');
    const load = vi.spyOn(fake.ports, 'get');
    const dialog = await screen.findByRole('dialog', { name: 'Retirar tercero' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Retirar' }));
    expect(await within(dialog).findByText(/ya lo actualizamos/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/Recarga para ver/)).toBeNull();
    expect(load).toHaveBeenCalled();
  });

  it('retries a failed first load', async () => {
    open(review(), 'third-parties', {
      prepare: (fake) => fake.failNext('thirdParties.list', 500),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByText('Sin terceros registrados')).toBeInTheDocument();
  });
});

describe('insurance', () => {
  it('shows each coverage state in plain words and saves the insurer data', async () => {
    const { container } = open(review(), 'insurance', { permissions: MANAGER });
    expect(
      await screen.findByText(
        'Indica la fecha y hora del evento para ubicar la póliza que lo cubría.',
      ),
    ).toBeInTheDocument();
    expect(await violations(container)).toEqual([]);
    fill('Aseguradora', 'Seguros Demo');
    fill('Número de siniestro de la aseguradora', 'SIN-998');
    fill('Día en que se avisó a la aseguradora', '2026-10-12');
    fill('Resultado de la aseguradora', 'accepted');
    press('Guardar datos del seguro');
    expect(await screen.findByText('Seguros Demo')).toBeInTheDocument();
    expect(screen.getAllByText('Aceptado').length).toBeGreaterThan(0);
    expect(screen.getByText('12/10/2026')).toBeInTheDocument();
  });

  it('says there is no policy at the event day and lets a caller read only', async () => {
    open(
      completeEvent({
        status: 'closed',
        version: 7,
        editableFields: [],
        coverage: { status: 'none', policy: null, alert: null },
      }),
      'insurance',
      { permissions: VIEWER },
    );
    expect(
      await screen.findByText('Sin póliza registrada vigente a la fecha del evento'),
    ).toBeInTheDocument();
    expect(screen.getByText(/El caso está cerrado: estos datos son historial/)).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Editar datos del seguro' })).toBeNull();
  });

  it('lets the caller choose among several policies and shows the chosen one', async () => {
    open(
      completeEvent({
        status: 'under_review',
        version: 4,
        coverage: { status: 'multiple', policy: null, alert: null },
      }),
      'insurance',
      {
        options: {
          suggestions: {
            drivers: [],
            policies: [
              {
                policyId: 'pol-a',
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
      },
    );
    expect(
      await screen.findByText(/Más de una póliza cubría el día del evento/),
    ).toBeInTheDocument();
    const select = await screen.findByLabelText('Póliza que aplica');
    fireEvent.change(select, { target: { value: 'pol-a' } });
    expect(await screen.findByText('POL-1')).toBeInTheDocument();
    expect(screen.getByText('01/01/2026 al 31/12/2026')).toBeInTheDocument();
    expect(screen.getByText('Todo riesgo')).toBeInTheDocument();
  });

  it('reloads the case when choosing the policy finds it changed', async () => {
    const { fake } = open(
      completeEvent({
        status: 'under_review',
        version: 4,
        coverage: { status: 'multiple', policy: null, alert: null },
      }),
      'insurance',
      {
        options: {
          suggestions: {
            drivers: [],
            policies: [
              {
                policyId: 'pol-a',
                revision: 1,
                insurer: 'Aseguradora A',
                policyNumber: 'A-1',
                coverageType: 'comprehensive',
                startsOn: '2026-01-01',
                endsOn: '2026-12-31',
              },
            ],
            coverage: { status: 'multiple', alert: null },
          },
        },
      },
    );
    const select = await screen.findByLabelText('Póliza que aplica');
    fake.failNext('updateInsurance', 409, 'stale_version');
    const load = vi.spyOn(fake.ports, 'get');
    fireEvent.change(select, { target: { value: 'pol-a' } });
    expect(await screen.findByText(/ya lo actualizamos/)).toBeInTheDocument();
    expect(screen.queryByText(/Recarga para ver/)).toBeNull();
    expect(load).toHaveBeenCalled();
  });
});

describe('summary, resolution and vehicle', () => {
  it('records the resolution and shows who approved, without any amount', async () => {
    const incident = completeEvent({
      status: 'under_review',
      version: 4,
      responsible: { id: 'user-2', displayName: 'Responsable de flotilla 1' },
    });
    open(incident, 'summary');
    await screen.findByText('Resolución');
    fill('Resumen de la resolución', 'Reparado en taller');
    fill('Estado en que queda el vehículo', 'active');
    fill('¿La empresa asume el costo?', 'yes');
    fill('¿Pérdida total?', 'no');
    press('Guardar resolución');
    expect(await screen.findByText('Resolución guardada.')).toBeInTheDocument();
    expect(screen.getAllByText('Reparado en taller').length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/\$|MXN|importe|monto/i);
  });

  it('shows approvals and who closed the case', async () => {
    const closed = completeEvent({
      status: 'closed',
      version: 12,
      editableFields: [],
      resolution: {
        resolutionSummary: 'Listo',
        totalLoss: false,
        vehicleStatusDecision: 'active',
        resolvedAt: '2026-10-12T16:00:00.000Z',
        closeApproval: {
          by: { id: 'u', displayName: 'Supervisora' },
          at: '2026-10-12T17:00:00.000Z',
        },
        closedAt: '2026-10-12T18:00:00.000Z',
        closedBy: { id: 'u2', displayName: 'Gerente' },
        cancelReason: null,
      },
      reopenCount: 2,
    });
    open(closed, 'summary', { permissions: VIEWER });
    expect(await screen.findByText(/Supervisora ·/)).toBeInTheDocument();
    expect(screen.getByText(/Gerente ·/)).toBeInTheDocument();
    expect(screen.getByText(/Este caso se reabrió 2 veces/)).toBeInTheDocument();
  });

  it('proposes a vehicle state but changes it only after an explicit confirmation', async () => {
    const incident = completeEvent({
      status: 'under_review',
      version: 4,
      vehicleOperable: false,
      vehicleProposal: { suggestedStatus: 'out_of_service', reason: 'No puede operar' },
    });
    const { fake } = open(incident, 'summary', {
      permissions: [...ADMIN, 'edit'],
      env: { mayChangeVehicles: true },
    });
    const apply = vi.spyOn(fake.ports.vehicles, 'applyStatus');
    fireEvent.click(
      await screen.findByRole('button', { name: 'Cambiar el vehículo a Fuera de servicio' }),
    );
    expect(apply).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog', { name: 'Cambiar el estado del vehículo' });
    expect(dialog).toHaveTextContent('con el motivo «Siniestro SIN-2026-000001»');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cambiar estado' }));
    expect(
      await screen.findByText('El vehículo quedó en «Fuera de servicio».'),
    ).toBeInTheDocument();
    expect(apply).toHaveBeenCalledWith('veh-001', 'out_of_service', 'Siniestro SIN-2026-000001');
  });

  it('keeps the vehicle proposal informational without permission and explains a failure', async () => {
    const incident = completeEvent({
      status: 'resolved',
      version: 8,
      vehicleProposal: { suggestedStatus: 'decommissioned', reason: 'Pérdida total' },
      resolution: { ...baseIncident().resolution, vehicleStatusDecision: 'active' },
    });
    const first = open(incident, 'summary', { permissions: VIEWER });
    expect((await screen.findAllByText(/Quien gestiona la flota puede aplicarlo/)).length).toBe(2);
    expect(screen.queryByRole('button', { name: /Cambiar el vehículo a/ })).toBeNull();
    first.unmount();
    const second = open(incident, 'summary', { env: { mayChangeVehicles: true } });
    fireEvent.click(
      await screen.findByRole('button', { name: 'Cambiar el vehículo a Dado de baja' }),
    );
    second.fake.failNext('vehicles.applyStatus', 409, 'invalid_transition');
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cambiar estado' }));
    expect(await within(dialog).findByText(/no admite esta acción/)).toBeInTheDocument();
  });

  it('shows the draft banner and a new-edit form that saves the event fields', async () => {
    const draft = completeEvent({ status: 'draft' });
    open(draft, 'summary');
    expect(await screen.findByText(/Este caso es un borrador/)).toBeInTheDocument();
    press('Continuar captura');
    await waitFor(() => expect(window.location.pathname).toBe('/incidents/new'));
  });

  it('edits the event with company-zone time and closes the form after saving', async () => {
    const incident = completeEvent({ status: 'reported', version: 2 });
    const { fake } = open(incident, 'summary');
    await screen.findByText('Datos del evento');
    const update = vi.spyOn(fake.ports, 'update');
    press('Editar datos del evento');
    fill('Fecha y hora del evento', '2026-10-12T10:15');
    fill('Gravedad', 'high');
    fill('¿El vehículo puede operar?', 'no');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Frente' }));
    press('Guardar cambios');
    expect(await screen.findByText('Cambios guardados.')).toBeInTheDocument();
    expect(update.mock.calls[0]?.[1]).toMatchObject({
      version: 2,
      occurredAt: '2026-10-12T16:15:00.000Z',
      severity: 'high',
      vehicleOperable: false,
      damage: { description: null, zones: ['front'] },
    });
    expect(screen.queryByRole('form', { name: 'Editar datos del evento' })).toBeNull();
  });

  it('shows a rule violation as an instruction', async () => {
    const { fake } = open(completeEvent({ status: 'reported', version: 2 }), 'summary');
    await screen.findByText('Datos del evento');
    press('Editar datos del evento');
    fill('Fecha y hora del evento', '2999-01-01T10:00');
    press('Guardar cambios');
    expect(await screen.findByRole('alert')).toHaveTextContent('no pueden ser futuras');
    void fake;
  });
});

describe('timeline', () => {
  it('lists what happened newest first, with names of fields and never values', async () => {
    const { fake } = open(completeEvent({ status: 'reported', version: 2 }), 'timeline');
    expect(await screen.findByText('Sin movimientos')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Resumen' }));
    press('Editar datos del evento');
    fill('Descripción', 'Otra descripción secreta');
    press('Guardar cambios');
    await screen.findByText('Cambios guardados.');
    fireEvent.click(screen.getByRole('tab', { name: 'Timeline' }));
    expect(await screen.findByText('Datos del caso actualizados')).toBeInTheDocument();
    expect(screen.getByText(/Cambió: descripción\./)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Otra descripción secreta/);
    void fake;
  });

  it('retries a failed load', async () => {
    open(completeEvent({ status: 'reported', version: 2 }), 'timeline', {
      prepare: (fake) => fake.failNext('timeline', 500),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Reintentar' }));
    await screen.findByRole('tab', { name: 'Timeline', selected: true });
  });
});

function EvidenceHarness(props: Partial<React.ComponentProps<typeof EvidenceTab>>) {
  const incident = useIncident('inc-001');
  if (!incident.data) return null;
  return (
    <EvidenceTab
      incident={incident.data}
      onVersion={() => incident.reload()}
      onReload={incident.reload}
      {...props}
    />
  );
}
const pick = (label: string, ...files: File[]) =>
  fireEvent.change(screen.getByLabelText(label), { target: { files } });
const photo = (bytes: number, type = 'image/jpeg', name = 'golpe.jpg') =>
  new File([new Uint8Array(bytes)], name, {
    type,
    lastModified: Date.parse('2026-10-12T10:00:00Z'),
  });
const network = {
  ok: false as const,
  error: { status: 500 as const, code: 'network_error', message: '', correlationId: '' },
};

describe('evidence', () => {
  afterEach(() => vi.restoreAllMocks());
  const setup = (props: Partial<React.ComponentProps<typeof EvidenceTab>> = {}, view: View = {}) =>
    renderIncident(<EvidenceHarness {...props} />, {
      options: { incidents: [review()] },
      ...view,
    });

  it('compresses an 8 MB photo to about 2 MB and declares it, uploading with the capture date', async () => {
    const compress = vi.fn(
      async (_file: Blob, target: number) => new Blob([new Uint8Array(target - 100)]),
    );
    const { fake, container } = setup({ compress, pollMs: 0 });
    await screen.findByRole('region', { name: 'Agregar evidencia' });
    expect(await violations(container)).toEqual([]);
    const upload = vi.spyOn(fake.ports.evidence, 'upload');
    pick('Tomar foto', photo(8 * 1024 * 1024));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    const body = upload.mock.calls[0]?.[1];
    expect(body).toMatchObject({
      clientCompressed: true,
      contentType: 'image/jpeg',
      category: 'photo',
      stage: 'on_site',
      capturedAt: '2026-10-12T10:00:00.000Z',
      name: 'golpe.jpg',
    });
    expect((body?.contentBase64.length ?? 0) * 0.75).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(
      await screen.findByText(/En revisión: aún no cuenta como evidencia/),
    ).toBeInTheDocument();
    expect(screen.getByText(/0 archivos cuentan/)).toBeInTheDocument();
  });

  it('uploads a PDF unchanged and a failed compression sends the original', async () => {
    const compress = vi.fn(async () => {
      throw new Error('no canvas');
    });
    const { fake } = setup({ compress, pollMs: 0 });
    await screen.findByRole('region', { name: 'Agregar evidencia' });
    const upload = vi.spyOn(fake.ports.evidence, 'upload');
    fill('Categoría', 'rejection_letter');
    pick(
      'Adjuntar archivos',
      new File([new Uint8Array(3_000_000)], 'carta.pdf', { type: 'application/pdf' }),
    );
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    expect(upload.mock.calls[0]?.[1]).toMatchObject({
      contentType: 'application/pdf',
      category: 'rejection_letter',
      name: 'carta.pdf',
    });
    expect(upload.mock.calls[0]?.[1]).not.toHaveProperty('clientCompressed');
    pick('Tomar foto', photo(3 * 1024 * 1024, 'image/jpeg', 'grande.jpg'));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
    expect(compress).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[1]?.[1]).not.toHaveProperty('clientCompressed');
    expect(upload.mock.calls[1]?.[1].name).toBe('grande.jpg');
    expect(((upload.mock.calls[1]?.[1].contentBase64.length ?? 0) * 3) / 4).toBeGreaterThan(
      3 * 1024 * 1024 - 10,
    );
  });

  it('retries once after a network cut with the same key, then keeps the file', async () => {
    const { fake } = setup({ retryDelays: [0], pollMs: 0, compress: async (f) => f });
    await screen.findByRole('region', { name: 'Agregar evidencia' });
    const real = fake.ports.evidence.upload;
    const upload = vi
      .spyOn(fake.ports.evidence, 'upload')
      .mockResolvedValueOnce(network)
      .mockResolvedValueOnce(network)
      .mockImplementation(real);
    pick('Adjuntar archivos', photo(1000, 'image/png', 'pequena.png'));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(3));
    const keys = upload.mock.calls.map((call) => call[2]);
    expect(new Set(keys).size).toBe(1);
    // The version is part of what the server hashes: a retry repeats the one the first attempt sent.
    expect(new Set(upload.mock.calls.map((call) => call[1].version)).size).toBe(1);
    expect(
      (await screen.findAllByText(/pequena.png/, undefined, { timeout: 3000 })).length,
    ).toBeGreaterThan(0);
    await waitFor(() => expect(fake.stored('inc-001')?.version).toBe(5));
  });

  it('stops with a clear reason and a retry button after repeated failures', async () => {
    const { fake } = setup({ retryDelays: [], pollMs: 0 });
    await screen.findByRole('region', { name: 'Agregar evidencia' });
    const real = fake.ports.evidence.upload;
    const upload = vi
      .spyOn(fake.ports.evidence, 'upload')
      .mockResolvedValueOnce(network)
      .mockResolvedValueOnce(network)
      .mockImplementation(real);
    pick(
      'Adjuntar archivos',
      new File([new Uint8Array(100)], 'nota.pdf', { type: 'application/pdf' }),
    );
    expect(
      (await screen.findAllByRole('alert')).map((alert) => alert.textContent).join(),
    ).toContain('nota.pdf: No pudimos contactar al servidor');
    fireEvent.click(screen.getByRole('button', { name: /Reintentar/ }));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.queryAllByRole('alert')).toHaveLength(0));
  });

  it('refuses a file over the limit and lets the person discard the failures', async () => {
    setup({ pollMs: 0 });
    await screen.findByRole('region', { name: 'Agregar evidencia' });
    pick(
      'Adjuntar archivos',
      new File([new Uint8Array(26 * 1024 * 1024)], 'enorme.pdf', { type: 'application/pdf' }),
    );
    expect((await screen.findAllByRole('alert')).map((a) => a.textContent).join()).toContain(
      'supera el máximo',
    );
    press('Descartar los archivos con error');
    await waitFor(() => expect(screen.queryAllByRole('alert')).toHaveLength(0));
  });

  it('refreshes while a file is in review and then offers the download', async () => {
    const { fake } = setup({ pollMs: 20, compress: async (f) => f });
    await screen.findByRole('region', { name: 'Agregar evidencia' });
    pick(
      'Adjuntar archivos',
      new File([new Uint8Array(100)], 'reporte.pdf', { type: 'application/pdf' }),
    );
    await screen.findByText(/En revisión/);
    fake.scan('inc-001');
    await screen.findByText('Guardado', undefined, { timeout: 3000 });
    expect(screen.getByText(/1 archivo cuenta/)).toBeInTheDocument();
    const create = vi.fn(() => 'blob:x');
    URL.createObjectURL = create;
    URL.revokeObjectURL = vi.fn();
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    press('Descargar reporte.pdf');
    await waitFor(() => expect(click).toHaveBeenCalled());
    press('Quitar reporte.pdf');
    expect(
      await screen.findByText('Archivo retirado.', undefined, { timeout: 3000 }).catch(() => null),
    ).toBeDefined();
    await waitFor(() => expect(screen.queryByText('reporte.pdf')).toBeNull());
  });

  it('reports a failed download and a failed removal', async () => {
    const { fake, onExpired } = setup({ pollMs: 20, compress: async (f) => f });
    await screen.findByRole('region', { name: 'Agregar evidencia' });
    pick(
      'Adjuntar archivos',
      new File([new Uint8Array(100)], 'a.pdf', { type: 'application/pdf' }),
    );
    await screen.findByText(/En revisión/);
    fake.scan('inc-001');
    await screen.findByText('Guardado');
    fake.failNext('evidence.content', 404, 'not_found');
    press('Descargar a.pdf');
    expect(await screen.findByText('No pudimos descargar el archivo.')).toBeInTheDocument();
    expect(onExpired).not.toHaveBeenCalled();
    // An expired session during a download goes to the shared session handling.
    fake.failNext('evidence.content', 401, 'unauthorized');
    press('Descargar a.pdf');
    await waitFor(() => expect(onExpired).toHaveBeenCalledTimes(1));
    fake.failNext('evidence.detach', 500);
    press('Quitar a.pdf');
    expect(await screen.findByText(/No pudimos quitar el archivo/)).toBeInTheDocument();
  });

  it('reloads the case when a detach finds it changed', async () => {
    const { fake } = setup({ pollMs: 20, compress: async (f) => f });
    await screen.findByRole('region', { name: 'Agregar evidencia' });
    pick(
      'Adjuntar archivos',
      new File([new Uint8Array(100)], 'a.pdf', { type: 'application/pdf' }),
    );
    await screen.findByText(/En revisión/);
    fake.scan('inc-001');
    await screen.findByText('Guardado');
    fake.failNext('evidence.detach', 409, 'stale_version');
    press('Quitar a.pdf');
    expect(await screen.findByText(/ya lo actualizamos/)).toBeInTheDocument();
    expect(screen.queryByText(/Recarga para ver/)).toBeNull();
  });

  it('explains why a closed case or a read-only caller cannot add files', async () => {
    const first = renderIncident(<EvidenceHarness />, {
      options: { incidents: [completeEvent({ status: 'closed', version: 9, editableFields: [] })] },
    });
    expect(await screen.findByText(/no admite nuevos archivos/)).toBeInTheDocument();
    first.unmount();
    renderIncident(<EvidenceHarness />, {
      permissions: VIEWER,
      options: { incidents: [review()] },
    });
    expect(await screen.findByText(/No tienes permiso para agregar archivos/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Tomar foto')).toBeNull();
  });

  it('retries a failed list', async () => {
    setup({}, { prepare: (fake) => fake.failNext('evidence.list', 500) });
    fireEvent.click(await screen.findByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByRole('region', { name: 'Agregar evidencia' })).toBeInTheDocument();
  });
});
