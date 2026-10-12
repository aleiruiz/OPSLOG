import React from 'react';
import Alert from '@mui/material/Alert';
import Card from '@mui/material/Card';
import Stack from '@mui/material/Stack';
import { Button, Field, FormSection } from '@opslog/ui';
import type { BffWorkOrder } from '@opslog/contracts';
import { VehiclePicker } from './VehiclePicker';
import type { MaintenancePorts } from './ports';

/** FR-102: a corrective order is registered by hand for a vehicle of the company. */
export function CorrectiveOrderForm({
  ports,
  onCreated,
  onCancel,
  onExpired,
}: {
  ports: MaintenancePorts;
  onCreated: (order: BffWorkOrder) => void;
  onCancel: () => void;
  onExpired: () => void;
}) {
  const [vehicleId, setVehicleId] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!vehicleId.trim() || !description.trim()) {
      setError('Indica el vehículo y describe la falla.');
      return;
    }
    setBusy(true);
    const result = await ports.orders.createCorrective({
      vehicleId: vehicleId.trim(),
      description: description.trim(),
    });
    setBusy(false);
    if (result.ok) return onCreated(result.value);
    if (result.error.status === 401) onExpired();
    setError(
      result.error.status === 404
        ? 'No encontramos ese vehículo en tu empresa.'
        : result.error.status === 403
          ? 'No tienes permiso para registrar órdenes.'
          : 'No pudimos registrar la orden. Intenta nuevamente.',
    );
  };
  return (
    <Card
      component="form"
      noValidate
      aria-label="Nueva orden correctiva"
      onSubmit={submit}
      sx={{ p: 2, mb: 3 }}
    >
      <FormSection title="Nueva orden correctiva" description="Se crea en estado Programada.">
        {error && (
          <Alert severity="error" role="alert">
            {error}
          </Alert>
        )}
        <VehiclePicker id="mnt-corrective-vehicle" value={vehicleId} onChange={setVehicleId} />
        <Field
          id="mnt-corrective-description"
          label="Descripción de la falla"
          required
          multiline
          minRows={2}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
        <Stack direction="row" gap={1}>
          <Button type="submit" variant="contained" loading={busy}>
            Registrar orden
          </Button>
          <Button variant="text" onClick={onCancel}>
            Cancelar
          </Button>
        </Stack>
      </FormSection>
    </Card>
  );
}
