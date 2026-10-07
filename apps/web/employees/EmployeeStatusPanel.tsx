import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import React from 'react';
import { Button, Field, Notifications, opslogTokens } from '@opslog/ui';
import type { Employee, EmployeeStatus } from '../app/types';
import type { StatusPanelState } from './employeeDetailState';
import { statusOrder, statusPresentation } from './labels';
import { MAX_REASON_LENGTH, STATUS_TRANSITIONS, isReasonValid } from './rules';

const { colors } = opslogTokens;

interface PanelErrors {
  to?: string | undefined;
  reason?: string | undefined;
}

export function StatusPanel({
  employee,
  state,
  draft,
  onCancel,
  onSubmit,
  onErrorAction,
}: {
  employee: Employee;
  state: StatusPanelState;
  draft: { to: EmployeeStatus | ''; reason: string };
  onCancel: () => void;
  onSubmit: (to: EmployeeStatus, reason: string) => void;
  onErrorAction: () => void;
}) {
  const uid = React.useId();
  const [to, setTo] = React.useState<EmployeeStatus | ''>(draft.to);
  const [reason, setReason] = React.useState(draft.reason);
  const [errors, setErrors] = React.useState<PanelErrors>({});
  const options = statusOrder.filter((status) =>
    STATUS_TRANSITIONS[employee.status].includes(status),
  );
  const alertRef = React.useRef<HTMLDivElement>(null);
  const firstRef = React.useRef<HTMLDivElement>(null);
  // The panel opens on its first field so the keyboard continues where the person asked for it.
  React.useEffect(() => firstRef.current?.querySelector('select')?.focus(), []);
  React.useEffect(() => {
    if (state.error) alertRef.current?.focus();
  }, [state.error]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (state.busy) return;
    const found: PanelErrors = {};
    if (to === '') found.to = 'Elige el nuevo estado.';
    if (!isReasonValid(reason))
      found.reason = `Escribe el motivo del cambio: una sola línea de hasta ${MAX_REASON_LENGTH} caracteres.`;
    setErrors(found);
    if (found.to) document.getElementById(`${uid}-to`)?.focus();
    else if (found.reason) document.getElementById(`${uid}-reason`)?.focus();
    else onSubmit(to as EmployeeStatus, reason.trim());
  };

  return (
    <Box
      component="form"
      noValidate
      onSubmit={submit}
      aria-label="Cambiar estado"
      sx={{ border: `1px solid ${colors.border}`, borderRadius: 1, p: 2, mb: 3, maxWidth: 720 }}
    >
      <Typography component="h2" variant="h2" sx={{ mb: 0.5 }}>
        Cambiar estado
      </Typography>
      <Typography color="text.secondary" sx={{ mb: 2 }}>
        El cambio queda en el historial con su motivo. La baja es definitiva.
      </Typography>
      {state.error && (
        <Box ref={alertRef} tabIndex={-1} sx={{ outline: 'none', mb: 2 }}>
          <Notifications
            messages={[{ id: 'status-error', text: state.error, severity: 'error' }]}
          />
          {state.errorActionLabel && (
            <Box sx={{ mt: 1 }}>
              <Button variant="outlined" onClick={onErrorAction}>
                {state.errorActionLabel}
              </Button>
            </Box>
          )}
        </Box>
      )}
      <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', md: '1fr 2fr' } }}>
        <Box ref={firstRef}>
          <Field
            id={`${uid}-to`}
            label="Nuevo estado"
            select
            SelectProps={{ native: true }}
            InputLabelProps={{ shrink: true }}
            value={to}
            onChange={(event) => {
              setTo(event.target.value as EmployeeStatus | '');
              setErrors((current) => ({ ...current, to: undefined }));
            }}
            required
            error={Boolean(errors.to)}
            {...(errors.to ? { helperText: errors.to } : {})}
            fullWidth
          >
            <option value="">Elige un estado</option>
            {options.map((status) => (
              <option key={status} value={status}>
                {statusPresentation[status].label}
              </option>
            ))}
          </Field>
        </Box>
        <Field
          id={`${uid}-reason`}
          label="Motivo"
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
            setErrors((current) => ({ ...current, reason: undefined }));
          }}
          required
          error={Boolean(errors.reason)}
          helperText={errors.reason ?? `Obligatorio, hasta ${MAX_REASON_LENGTH} caracteres.`}
          fullWidth
        />
      </Box>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 2 }}>
        <Button type="submit" variant="contained" loading={state.busy}>
          Cambiar estado
        </Button>
        <Button variant="text" onClick={onCancel} disabled={state.busy}>
          Cancelar
        </Button>
      </Box>
    </Box>
  );
}
