import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { useIncidentEnv } from './context';
import { IncidentSettingsScreen } from './IncidentSettingsScreen';
import { applyEdits, toInput, valuesOf, validate } from './settingsModel';
import { ADMIN, VIEWER, renderIncident, violations, type View } from './testing';

function Screen() {
  const env = useIncidentEnv();
  return <IncidentSettingsScreen ports={env.ports} onExpired={env.onExpired} />;
}
const open = (view: View = {}) => renderIncident(<Screen />, { permissions: ADMIN, ...view });
const fill = (label: string | RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Guardar configuración' }));

describe('incident settings', () => {
  it('shows the server defaults and is accessible', async () => {
    const { container } = open();
    expect(await screen.findByLabelText('Días para casos de gravedad crítica')).toHaveValue('7');
    expect(screen.getByLabelText('Días para casos de gravedad alta')).toHaveValue('15');
    expect(screen.getByLabelText('Días para casos de gravedad media')).toHaveValue('30');
    expect(screen.getByLabelText('Días para casos de gravedad baja')).toHaveValue('45');
    expect(screen.getByLabelText('Días sin movimiento')).toHaveValue('5');
    expect(screen.getByLabelText('Foto al reportar')).toHaveValue('photo_or_justification');
    expect(screen.getByLabelText(/Umbral de aprobación/)).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Guardar configuración' })).toBeDisabled();
    expect(await violations(container)).toEqual([]);
  });

  it('saves the changed fields and keeps what the alert settings screen owns', async () => {
    const { fake } = open({
      options: { settings: { expiryWindowDays: 12, recipientRoles: ['admin'] } },
    });
    await screen.findByLabelText('Días sin movimiento');
    const save_ = vi.spyOn(fake.ports.settings, 'save');
    fill('Días para casos de gravedad crítica', '5');
    fill('Días sin movimiento', '10');
    fill('Foto al reportar', 'photo_required');
    fill(/Umbral de aprobación/, '1500.5');
    fill('Moneda del umbral', 'usd');
    save();
    expect(await screen.findByText('Configuración guardada.')).toBeInTheDocument();
    expect(save_).toHaveBeenCalledWith({
      version: 0,
      expiryWindowDays: 12,
      recipientRoles: ['admin'],
      incidentReportPhoto: 'photo_required',
      incidentSlaDays: { critical: 5, high: 15, medium: 30, low: 45 },
      incidentInactivityDays: 10,
      closeCostThreshold: { amountMinor: '150050', currency: 'USD' },
    });
    expect(screen.getByLabelText(/Umbral de aprobación/)).toHaveValue('1500.50');
    expect(screen.getByRole('button', { name: 'Guardar configuración' })).toBeDisabled();
  });

  it('clears the threshold when the field is emptied', async () => {
    const { fake } = open({
      options: { settings: { closeCostThreshold: { amountMinor: '100000', currency: 'MXN' } } },
    });
    expect(await screen.findByLabelText(/Umbral de aprobación/)).toHaveValue('1000.00');
    const save_ = vi.spyOn(fake.ports.settings, 'save');
    fill(/Umbral de aprobación/, '');
    save();
    await screen.findByText('Configuración guardada.');
    expect(save_.mock.calls[0]?.[0].closeCostThreshold).toBeNull();
  });

  it('refuses days, inactivity and amounts the server would refuse, without sending', async () => {
    const { fake } = open();
    await screen.findByLabelText('Días sin movimiento');
    fill('Días para casos de gravedad crítica', '0');
    fill('Días para casos de gravedad baja', '366');
    fill('Días sin movimiento', '61');
    fill(/Umbral de aprobación/, '12.345');
    save();
    expect(
      await screen.findAllByText('Escribe un número entero de días entre 1 y 365.'),
    ).toHaveLength(2);
    expect(screen.getByText('Escribe un número entero de días entre 1 y 60.')).toBeInTheDocument();
    expect(screen.getByText(/Escribe un monto mayor a cero/)).toBeInTheDocument();
    expect(fake.calls).not.toContain('settings.save');
    fill('Días para casos de gravedad crítica', '7');
    fill('Días para casos de gravedad baja', '45');
    fill('Días sin movimiento', '5');
    fill(/Umbral de aprobación/, '10');
    fill('Moneda del umbral', 'MX');
    expect(await screen.findByText(/código de moneda de tres letras/)).toBeInTheDocument();
  });

  it('keeps the typed values after a conflict and saves them on the current version', async () => {
    const { fake } = open();
    await screen.findByLabelText('Días sin movimiento');
    fill('Días sin movimiento', '9');
    // Somebody else saves first.
    await fake.ports.settings.save({
      version: 0,
      expiryWindowDays: 30,
      recipientRoles: ['admin', 'editor'],
      incidentInactivityDays: 3,
    });
    save();
    expect(
      await screen.findByText(/La configuración cambió mientras la editabas/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Recargar' }));
    await waitFor(() =>
      expect(fake.calls.filter((call) => call === 'settings.get')).toHaveLength(2),
    );
    expect(screen.getByLabelText('Días sin movimiento')).toHaveValue('9');
    save();
    expect(await screen.findByText('Configuración guardada.')).toBeInTheDocument();
    expect(screen.getByLabelText('Días sin movimiento')).toHaveValue('9');
  });

  it('explains a refusal of permission and a failed load', async () => {
    const { unmount } = open({ permissions: VIEWER });
    await screen.findByLabelText('Días sin movimiento');
    fill('Días sin movimiento', '9');
    save();
    expect(await screen.findByText('No tienes permiso para esta acción.')).toBeInTheDocument();
    unmount();
    open({ prepare: (fake) => fake.failNext('settings.get', 500) });
    fireEvent.click(await screen.findByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByLabelText('Días sin movimiento')).toBeInTheDocument();
  });
});

describe('settings model', () => {
  it('reads the defaults when the server sends none and rebuilds the same write', () => {
    const base = valuesOf({
      expiryWindowDays: 30,
      recipientRoles: ['admin'],
      maintenanceEvidence: 'none',
      closeCostThreshold: null,
      timeZone: 'UTC',
      version: 3,
      updatedBy: null,
      updatedAt: null,
    });
    expect(base.days).toEqual({ critical: '7', high: '15', medium: '30', low: '45' });
    expect(base.inactivity).toBe('5');
    expect(validate(base)).toEqual({});
    expect(applyEdits(base, { days: { high: '20' } }).days.high).toBe('20');
    expect(
      toInput(
        {
          expiryWindowDays: 30,
          recipientRoles: ['admin'],
          maintenanceEvidence: 'none',
          closeCostThreshold: null,
          timeZone: 'UTC',
          version: 3,
          updatedBy: null,
          updatedAt: null,
        },
        base,
      ).closeCostThreshold,
    ).toBeNull();
  });
});
