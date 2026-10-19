import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { createMockApi } from '../../app/mockApi';
import {
  click,
  fireEvent,
  renderApp,
  renderWithSession,
  screen,
  waitFor,
  within,
} from '../../app/test/utils';
import { AuditScreen } from './AuditScreen';
import { EntityAuditTab } from './EntityAuditTab';
import { CLEAN_RECONCILIATION, createFakeAudit, demoEntries, makeEntry } from './fakePorts';

const NOW = () => Date.parse('2026-10-19T12:00:00Z');
const withAudit = (audit = createFakeAudit()) => ({
  audit,
  api: Object.assign(createMockApi(), { audit }),
});
const rows = (table: HTMLElement) => within(table).getAllByRole('row').slice(1);
const choose = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const eventsTable = (total: number) =>
  screen.findByRole('table', { name: `Eventos de auditoría (${total})` });

async function violations(container: HTMLElement): Promise<string[]> {
  const results = await axe.run(container, {
    rules: { 'color-contrast': { enabled: false }, 'heading-order': { enabled: false } },
  });
  return results.violations.map((item) => item.id);
}

describe('audit screen', () => {
  it('lists the newest events first with names, never ids, and is accessible', async () => {
    const { api } = withAudit();
    const { container } = await renderWithSession(<AuditScreen now={NOW} />, { api });
    const table = await eventsTable(63);
    expect(rows(table)).toHaveLength(50);
    expect(rows(table)[0]).toHaveTextContent('Siniestro actualizado');
    expect(rows(table)[0]).toHaveTextContent('SIN-2026-000001');
    expect(rows(table)[0]).toHaveTextContent('Administración');
    expect(rows(table)[0]).toHaveTextContent('U-7F3A21');
    expect(table).not.toHaveTextContent(/evt-|usr-|corr-|veh-001/);
    expect(screen.queryByRole('button', { name: /exportar/i })).toBeNull();
    expect(await violations(container)).toEqual([]);
  });

  it('loads more events with the cursor and stops when there are no more', async () => {
    const { api, audit } = withAudit();
    await renderWithSession(<AuditScreen now={NOW} />, { api });
    await eventsTable(63);
    click('Cargar más eventos');
    await waitFor(() =>
      expect(rows(screen.getByRole('table', { name: /Eventos/ }))).toHaveLength(63),
    );
    expect(screen.queryByRole('button', { name: 'Cargar más eventos' })).toBeNull();
    expect(audit.calls.at(-1)).toMatchObject({ cursor: '50', limit: 50 });
  });

  it('filters by result and module, and offers to clear them', async () => {
    const { api, audit } = withAudit();
    await renderWithSession(<AuditScreen now={NOW} />, { api });
    await eventsTable(63);
    choose('Resultado', 'denied');
    const table = await eventsTable(1);
    expect(rows(table)[0]).toHaveTextContent('Denegada');
    expect(audit.calls.at(-1)).toMatchObject({ result: 'denied' });
    choose('Módulo', 'role.');
    expect(await screen.findByText(/No hay resultados|Sin resultados/i)).toBeInTheDocument();
    click('Limpiar filtros');
    await eventsTable(63);
  });

  it('applies date shortcuts in the company zone and validates the range', async () => {
    const { api, audit } = withAudit();
    await renderWithSession(<AuditScreen now={NOW} />, { api });
    await eventsTable(63);
    click('Últimos 7 días');
    await waitFor(() =>
      expect(audit.calls.at(-1)).toMatchObject({
        from: '2026-10-13T00:00:00.000Z',
        to: '2026-10-20T00:00:00.000Z',
      }),
    );
    click('Hoy');
    await waitFor(() =>
      expect(audit.calls.at(-1)).toMatchObject({ from: '2026-10-19T00:00:00.000Z' }),
    );
    fireEvent.change(screen.getByLabelText('Hasta'), { target: { value: '2026-10-01' } });
    expect(
      await screen.findByText('La fecha inicial no puede ser posterior a la final.'),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Desde'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Hasta'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Desde'), { target: { value: '2025-01-01' } });
    const before = audit.calls.length;
    expect(screen.getByText('Indica la fecha inicial y la final.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Hasta'), { target: { value: '2026-10-01' } });
    expect(screen.getByText('El rango no puede superar 366 días.')).toBeInTheDocument();
    expect(audit.calls.length).toBe(before);
  });

  it('shows the empty state when nothing happened in the period', async () => {
    const { api } = withAudit(createFakeAudit([]));
    await renderWithSession(<AuditScreen now={NOW} />, { api });
    expect(await screen.findByText('Sin eventos en el periodo')).toBeInTheDocument();
  });

  it('shows the field diff: values, restricted fields and unrecorded fields', async () => {
    const { api } = withAudit();
    const { container } = await renderWithSession(<AuditScreen now={NOW} />, { api });
    const table = await eventsTable(63);
    const opener = within(rows(table)[0] as HTMLElement).getByRole('button', {
      name: /^Ver detalle: Siniestro actualizado/,
    });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole('dialog', { name: 'Siniestro actualizado' });
    expect(dialog).toHaveTextContent('Gravedad: Baja → Alta');
    expect(dialog).toHaveTextContent('Vehículo operable: Sí → No');
    expect(dialog).toHaveTextContent('Descripción: valor restringido');
    expect(dialog).toHaveTextContent(
      'Resultado de la aseguradora: cambió (el historial no guarda su valor)',
    );
    expect(dialog).not.toHaveTextContent(/\blow\b|\bhigh\b|evt-|usr-/);
    expect(await violations(container)).toEqual([]);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('says so when a record has no field history, and when it no longer exists', async () => {
    const { api } = withAudit();
    await renderWithSession(<AuditScreen now={NOW} />, { api });
    const table = await eventsTable(63);
    expect(rows(table)[2]).toHaveTextContent('Registro no disponible');
    fireEvent.click(
      within(rows(table)[2] as HTMLElement).getByRole('button', { name: /^Ver detalle/ }),
    );
    expect(await screen.findByRole('dialog')).toHaveTextContent(
      'no guarda el detalle de los campos cambiados',
    );
  });

  it('reports a failed listing and retries', async () => {
    const { api, audit } = withAudit();
    audit.failNext('list', 500);
    await renderWithSession(<AuditScreen now={NOW} />, { api });
    fireEvent.click(await screen.findByRole('button', { name: 'Reintentar' }));
    await eventsTable(63);
  });

  it('reports a failure while loading more without losing the loaded events', async () => {
    const audit = createFakeAudit();
    const { api } = withAudit(audit);
    await renderWithSession(<AuditScreen now={NOW} />, { api });
    await eventsTable(63);
    audit.failNext('list', 500);
    click('Cargar más eventos');
    expect(await screen.findByText(/No se pudieron cargar más eventos/)).toBeInTheDocument();
    expect(rows(screen.getByRole('table', { name: /Eventos/ }))).toHaveLength(50);
  });

  it('asks to sign in again when the session expires', async () => {
    const { api, audit } = withAudit();
    audit.failNext('list', 401);
    await renderWithSession(<AuditScreen now={NOW} />, { api });
    expect((await screen.findAllByText(/Datos no disponibles|sesión/i)).length).toBeGreaterThan(0);
  });

  it('shows the reconciliation, clean or with the pending events', async () => {
    const audit = createFakeAudit();
    const { api } = withAudit(audit);
    await renderWithSession(<AuditScreen now={NOW} />, { api });
    expect(
      await screen.findByText('Todos los eventos del periodo ya aparecen en la consulta.'),
    ).toBeInTheDocument();
  });

  it('lists pending events oldest first with their wait, read-only', async () => {
    const audit = createFakeAudit();
    audit.reconciliationResult = {
      ok: true,
      value: {
        ...CLEAN_RECONCILIATION,
        relayed: 61,
        pendingTotal: 2,
        oldestPendingAgeSeconds: 7300,
        pending: [
          {
            eventId: 'evt-p1',
            occurredAt: '2026-10-19T09:00:00.000Z',
            action: 'vehicle.updated',
            entityType: 'vehicle',
            delivery: 'pending',
            ageSeconds: 7300,
          },
          {
            eventId: 'evt-p2',
            occurredAt: '2026-10-19T11:00:00.000Z',
            action: 'vehicle.created',
            entityType: 'vehicle',
            delivery: 'missing',
            ageSeconds: 45,
          },
        ],
      },
    };
    const { api } = withAudit(audit);
    await renderWithSession(<AuditScreen now={NOW} />, { api });
    const alert = await screen.findByText(/Hay 2 eventos registrados que aún no aparecen/);
    expect(alert).toHaveTextContent('El más antiguo espera 2 h');
    const table = screen.getByRole('table', { name: 'Eventos pendientes (2)' });
    expect(rows(table)[0]).toHaveTextContent('Pendiente');
    expect(rows(table)[1]).toHaveTextContent('Sin entrega registrada');
    expect(rows(table)[1]).toHaveTextContent('menos de 1 min');
    expect(within(table).queryByRole('button')).toBeNull();
  });

  it('reports a failed reconciliation on its own', async () => {
    const { api, audit } = withAudit();
    audit.failNext('reconciliation', 500);
    await renderWithSession(<AuditScreen now={NOW} />, { api });
    await eventsTable(63);
    expect(await screen.findAllByRole('button', { name: 'Reintentar' })).toHaveLength(1);
  });
});

describe('audit in the application', () => {
  it('shows «Auditoría» under «Análisis» to people with view_audit and opens it', async () => {
    await renderApp({ path: '/' });
    const group = await screen.findByRole('region', { name: 'Análisis' });
    fireEvent.click(within(group).getByRole('link', { name: 'Auditoría' }));
    expect(await screen.findByRole('heading', { name: 'Auditoría', level: 1 })).toBeInTheDocument();
    await eventsTable(63);
    expect(window.location.pathname).toBe('/analisis/auditoria');
  });

  it('hides the entry and refuses the address without view_audit', async () => {
    await renderApp({ account: 'viewer', path: '/' });
    await screen.findByRole('heading', { name: 'Inicio', level: 1 });
    expect(screen.queryByRole('region', { name: 'Análisis' })).toBeNull();
    window.history.pushState(null, '', '/analisis/auditoria');
    fireEvent(window, new PopStateEvent('popstate'));
    expect(await screen.findByText('No tienes acceso')).toBeInTheDocument();
  });
});

describe('record history tab', () => {
  it('lists only the events of the record, without the record column', async () => {
    const entries = [
      ...demoEntries(),
      makeEntry(99, {
        entityId: 'veh-007',
        entityLabel: 'ECO-007',
        actionLabel: 'Vehículo creado',
      }),
    ];
    const { api, audit } = withAudit(createFakeAudit(entries));
    const { container } = await renderWithSession(
      <EntityAuditTab entityType="vehicle" entityId="veh-007" />,
      { api },
    );
    const table = await screen.findByRole('table', { name: 'Eventos de auditoría (1)' });
    expect(rows(table)).toHaveLength(1);
    expect(within(table).queryByRole('columnheader', { name: 'Registro' })).toBeNull();
    expect(audit.calls[0]).toMatchObject({ entityType: 'vehicle', entityId: 'veh-007' });
    expect(await violations(container)).toEqual([]);
  });

  it('says there is no activity, and refuses people without view_audit or the module permission', async () => {
    const { api } = withAudit(createFakeAudit([]));
    const first = await renderWithSession(
      <EntityAuditTab entityType="vehicle" entityId="veh-1" />,
      { api },
    );
    expect(await screen.findByText('Sin eventos en el periodo')).toBeInTheDocument();
    first.unmount();
    const denied = await renderWithSession(
      <EntityAuditTab entityType="vehicle" entityId="veh-1" />,
      { api: withAudit().api, account: 'viewer' },
    );
    expect(await screen.findByText('No tienes acceso')).toBeInTheDocument();
    denied.unmount();
  });

  it('shows no permission when the server refuses the module', async () => {
    const { api, audit } = withAudit();
    audit.failNext('forEntity', 403);
    await renderWithSession(<EntityAuditTab entityType="incident" entityId="inc-001" />, { api });
    expect(await screen.findByText('No tienes acceso')).toBeInTheDocument();
  });
});
