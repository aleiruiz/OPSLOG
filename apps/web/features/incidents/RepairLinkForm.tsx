import React from 'react';
import { Button, InlineAlert, UiState } from '@opslog/ui';
import type { BffIncident, BffRepairLink } from '@opslog/contracts';
import { errorKind } from '../maintenance/useResult';
import { useIncidentEnv } from './context';
import type { SubmitOutcome } from './EventForm';
import { describeError } from './errors';
import { outcomeOf } from './outcome';
import { RecordForm } from './RecordForm';
import { CreateOrderForm } from './CreateOrderForm';
import { linkableOrders, linkOrder, orderLabel } from './repairLinking';
import type { OrderDraft } from './orderDraft';
import { SubmitKeys } from './submit';
import { useLive } from './useLive';

/**
 * Vincular una orden: a choice among the corrective orders of the same vehicle (never a typed id), or a new
 * corrective order registered from the case and linked right away. Needs the maintenance module's generic
 * `view` to list orders and `create` to register one; without them the form says so instead of failing.
 */
export function RepairLinkForm({
  incident,
  links,
  draft,
  onLinked,
  onReload,
  onClose,
}: {
  incident: BffIncident;
  draft: OrderDraft;
  links: readonly BffRepairLink[];
  onLinked: (version: number, message: string) => void;
  onReload: () => void;
  onClose: () => void;
}) {
  const env = useIncidentEnv();
  const mayList = env.permissions.includes('view');
  const mayCreate = env.permissions.includes('create');
  const keys = React.useRef(new SubmitKeys());
  const orders = useLive(
    () =>
      mayList
        ? env.ports.orders.list()
        : Promise.resolve({
            ok: false as const,
            error: { status: 403 as const, code: 'forbidden', message: '', correlationId: '' },
          }),
    [env.ports, incident.vehicle.id, links.length],
    env.onExpired,
  );
  const choices = linkableOrders(
    orders.data ?? [],
    incident,
    links.map((link) => link.orderId),
  );
  const link = async (changed: Readonly<Record<string, string>>): Promise<SubmitOutcome> => {
    const orderId = changed['orderId'];
    if (!orderId) return { ok: false, message: 'Elige la orden que vas a vincular.' };
    const result = await linkOrder(env.ports, keys.current, incident, orderId);
    if (!result.ok && result.error.status === 409 && result.error.code === 'duplicate')
      return { ok: false, message: 'Esa orden ya está vinculada a un siniestro.' };
    return outcomeOf(
      result,
      env.onExpired,
      (change) => onLinked(change.version, 'Orden vinculada.'),
      'vincular la orden',
    );
  };
  return (
    <>
      {!mayList ? (
        <InlineAlert severity="info">
          Para vincular una orden hace falta poder consultar mantenimiento. Pide a una persona con
          ese permiso que la vincule.
        </InlineAlert>
      ) : orders.data === null ? (
        orders.error ? (
          <UiState
            kind={errorKind(orders.error)}
            actionLabel="Reintentar"
            onAction={orders.reload}
          />
        ) : (
          <UiState kind="loading" />
        )
      ) : choices.length === 0 ? (
        <InlineAlert severity="info">
          No hay órdenes correctivas de este vehículo por vincular. Registra una nueva abajo.
        </InlineAlert>
      ) : (
        <RecordForm
          label="Vincular orden"
          fields={[
            {
              key: 'orderId',
              label: 'Orden correctiva del vehículo',
              kind: 'select',
              required: true,
              empty: 'Elige una orden',
              options: choices.map((order) => ({
                value: order.id,
                label: orderLabel(order, env.zone),
              })),
            },
          ]}
          base={{ orderId: '' }}
          submitLabel="Vincular orden"
          onSubmit={link}
          onReload={onReload}
        />
      )}
      {mayCreate ? (
        <CreateOrderForm
          incident={incident}
          draft={draft}
          onLinked={onLinked}
          onReload={onReload}
          describe={(error) => describeError(error, 'registrar la orden')}
        />
      ) : (
        <InlineAlert severity="info">
          Registrar una orden nueva requiere permiso de creación en mantenimiento.
        </InlineAlert>
      )}
      <Button variant="text" onClick={onClose}>
        Cerrar
      </Button>
    </>
  );
}
