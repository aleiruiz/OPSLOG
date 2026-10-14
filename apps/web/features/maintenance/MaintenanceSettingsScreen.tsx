import React from 'react';
import Alert from '@mui/material/Alert';
import Card from '@mui/material/Card';
import MenuItem from '@mui/material/MenuItem';
import { Button, Field, FormSection, PageHeader, UiState } from '@opslog/ui';
import type {
  BffAlertSettings,
  BffCloseCostThreshold,
  BffMaintenanceEvidenceRequirement,
} from '@opslog/contracts';
import type { MaintenancePorts } from './ports';
import { errorKind, useResult } from './useResult';

const EVIDENCE_LABELS: Readonly<Record<BffMaintenanceEvidenceRequirement, string>> = {
  none: 'No se exige',
  evidence: 'Evidencia del trabajo',
  evidence_invoice: 'Evidencia y factura',
};

/** Decimal major units to exact minor units (two decimals); `null` when it is not a plain amount. */
export function toMinorUnits(text: string): string | null {
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!match) return null;
  const minor = `${match[1]}${(match[2] ?? '').padEnd(2, '0')}`.replace(/^0+(?=\d)/, '');
  return minor;
}
const fromMinorUnits = (threshold: BffCloseCostThreshold | null | undefined): string => {
  if (!threshold) return '';
  const digits = threshold.amountMinor.padStart(3, '0');
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
};

function SettingsForm({
  settings,
  ports,
  onExpired,
}: {
  settings: BffAlertSettings;
  ports: MaintenancePorts;
  onExpired: () => void;
}) {
  const [current, setCurrent] = React.useState(settings);
  const [evidence, setEvidence] = React.useState(settings.maintenanceEvidence);
  const [amount, setAmount] = React.useState(fromMinorUnits(settings.closeCostThreshold));
  const [currency, setCurrency] = React.useState(settings.closeCostThreshold?.currency ?? 'MXN');
  const [zone, setZone] = React.useState(settings.timeZone);
  // Absent without `incidents:view_costs`: the field is hidden and a save leaves the stored value.
  const hasThreshold = current.closeCostThreshold !== undefined;
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<{ ok: boolean; text: string } | null>(null);
  const minor = amount.trim() === '' ? null : toMinorUnits(amount);
  const amountError = amount.trim() !== '' && minor === null;
  const currencyError = amount.trim() !== '' && !/^[A-Z]{3}$/.test(currency);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (amountError || currencyError || busy) return;
    setBusy(true);
    setNotice(null);
    const result = await ports.settings.save({
      version: current.version,
      expiryWindowDays: current.expiryWindowDays,
      recipientRoles: current.recipientRoles,
      maintenanceEvidence: evidence,
      ...(hasThreshold
        ? { closeCostThreshold: minor === null ? null : { amountMinor: minor, currency } }
        : {}),
      timeZone: zone.trim(),
    });
    setBusy(false);
    if (result.ok) {
      setCurrent(result.value);
      setNotice({ ok: true, text: 'Configuración guardada.' });
      return;
    }
    if (result.error.status === 401) return onExpired();
    setNotice({
      ok: false,
      text:
        result.error.status === 409
          ? 'La configuración cambió. Recarga la pantalla e intenta de nuevo.'
          : result.error.status === 400 || result.error.status === 422
            ? 'Revisa los datos: la zona horaria debe ser válida, por ejemplo America/Mexico_City.'
            : result.error.status === 403
              ? 'No tienes permiso para cambiar la configuración.'
              : 'No pudimos guardar la configuración. Intenta nuevamente.',
    });
  };
  return (
    <Card
      component="form"
      aria-label="Configuración de mantenimiento"
      onSubmit={submit}
      sx={{
        p: { xs: 2, sm: 2.5 },
        maxWidth: 760,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 2,
        '& > *': { alignSelf: 'stretch' },
        '& > button': { alignSelf: 'flex-start' },
      }}
    >
      <FormSection
        title="Requisitos de las órdenes"
        description="Se aplican al completar y cerrar órdenes de mantenimiento."
      >
        <Field
          id="mnt-set-evidence"
          select
          label="Archivos requeridos"
          value={evidence}
          onChange={(event) => setEvidence(event.target.value as BffMaintenanceEvidenceRequirement)}
        >
          {(Object.keys(EVIDENCE_LABELS) as BffMaintenanceEvidenceRequirement[]).map((key) => (
            <MenuItem key={key} value={key}>
              {EVIDENCE_LABELS[key]}
            </MenuItem>
          ))}
        </Field>
        {hasThreshold && (
          <>
            <Field
              id="mnt-set-amount"
              label="Umbral de cierre costoso (opcional)"
              helperText={
                amountError
                  ? 'Escribe un monto con hasta dos decimales.'
                  : 'Si lo defines, todo cierre requiere aprobación previa. Déjalo vacío para no exigirla.'
              }
              error={amountError}
              value={amount}
              inputProps={{ inputMode: 'decimal' }}
              onChange={(event) => setAmount(event.target.value)}
            />
            <Field
              id="mnt-set-currency"
              label="Moneda del umbral"
              helperText={
                currencyError ? 'Usa un código de tres letras, por ejemplo MXN.' : undefined
              }
              error={currencyError}
              value={currency}
              onChange={(event) => setCurrency(event.target.value.toUpperCase())}
            />
          </>
        )}
        <Field
          id="mnt-set-zone"
          label="Zona horaria de la empresa"
          helperText="Define el día calendario de planes y fechas reales (por ejemplo America/Mexico_City)."
          value={zone}
          onChange={(event) => setZone(event.target.value)}
        />
      </FormSection>
      {notice && (
        <Alert severity={notice.ok ? 'success' : 'error'} role={notice.ok ? 'status' : 'alert'}>
          {notice.text}
        </Alert>
      )}
      <Button type="submit" variant="contained" disabled={busy || amountError || currencyError}>
        Guardar configuración
      </Button>
    </Card>
  );
}

/** Company settings that drive maintenance (G3 H3 and D20); the server checks `manage_config`. */
export function MaintenanceSettingsScreen({
  ports,
  onExpired,
}: {
  ports: MaintenancePorts;
  onExpired: () => void;
}) {
  const { state, reload } = useResult(() => ports.settings.get(), [ports], onExpired);
  return (
    <section aria-label="Configuración de mantenimiento">
      <PageHeader
        eyebrow="Mantenimiento"
        title="Configuración de mantenimiento"
        description="Evidencia, aprobación de cierres y zona horaria."
      />
      {state.status === 'loading' && <UiState kind="loading" />}
      {state.status === 'error' && (
        <UiState kind={errorKind(state.error)} actionLabel="Reintentar" onAction={reload} />
      )}
      {state.status === 'ready' && (
        <SettingsForm settings={state.data} ports={ports} onExpired={onExpired} />
      )}
    </section>
  );
}
