import React from 'react';
import Box from '@mui/material/Box';
import { Button, Field, InlineAlert } from '@opslog/ui';
import type { ApiError, BffIncident } from '@opslog/contracts';
import { useIncidentEnv } from './context';
import { RELOADED_COPY, isStale } from './errors';
import type { OrderDraft } from './orderDraft';
import { linkOrder } from './repairLinking';
import { sendKeyed } from './submit';

/**
 * Crear orden correctiva (FR-102): two calls, as the contract defines. The order is registered with the
 * maintenance endpoint and then linked, each under its own `Idempotency-Key`. The screen also keeps the order it
 * created (in the repair tab, so closing the dialog does not lose it): a failed link retries only the link.
 */
export function CreateOrderForm({
  incident,
  draft,
  onLinked,
  onReload,
  describe,
}: {
  incident: BffIncident;
  draft: OrderDraft;
  onLinked: (version: number, message: string) => void;
  onReload: () => void;
  describe: (error: ApiError) => string;
}) {
  const env = useIncidentEnv();
  const { description, setDescription, created, setCreated } = draft;
  const [busy, setBusy] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);
  const busyRef = React.useRef(false);
  const id = React.useId();

  const submit = async () => {
    if (busyRef.current) return;
    if (created === null && !description.trim()) {
      setProblem('Describe la falla que se va a reparar.');
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setProblem(null);
    let orderId = created;
    if (orderId === null) {
      const body = { vehicleId: incident.vehicle.id, description: description.trim() };
      const order = await sendKeyed(draft.keys.current, [incident.id, 'create', body], (key) =>
        env.ports.orders.createCorrective(body, key),
      );
      if (!order.ok) {
        if (order.error.status === 401) env.onExpired();
        busyRef.current = false;
        setBusy(false);
        setProblem(describe(order.error));
        return;
      }
      orderId = order.value.id;
      setCreated(orderId);
    }
    const linked = await linkOrder(env.ports, draft.keys.current, incident, orderId);
    busyRef.current = false;
    setBusy(false);
    if (linked.ok) {
      onLinked(linked.value.version, 'Orden creada y vinculada.');
      return;
    }
    if (linked.error.status === 401) env.onExpired();
    if (isStale(linked.error)) {
      onReload();
      setProblem(`La orden se creó, pero el caso cambió. ${RELOADED_COPY}`);
    } else
      setProblem(
        `La orden se creó, pero no pudimos vincularla: ${describe(linked.error)} Puedes reintentar el vínculo.`,
      );
  };

  return (
    <Box
      component="form"
      aria-label="Crear orden correctiva"
      noValidate
      onSubmit={(event: React.FormEvent) => {
        event.preventDefault();
        void submit();
      }}
      sx={{ display: 'grid', gap: 2, maxWidth: 720, mt: 3 }}
    >
      {problem && <InlineAlert severity="error">{problem}</InlineAlert>}
      <Field
        id={`${id}-description`}
        label="Descripción de la falla"
        required
        multiline
        minRows={2}
        value={description}
        disabled={created !== null}
        description="La orden se registra como correctiva del vehículo de este caso y se vincula al terminar."
        onChange={(event) => setDescription(event.target.value)}
      />
      <Box>
        <Button type="submit" variant="outlined" loading={busy}>
          {created === null ? 'Crear orden y vincular' : 'Vincular orden creada'}
        </Button>
      </Box>
    </Box>
  );
}
