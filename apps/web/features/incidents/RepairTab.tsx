import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { Button, ConfirmDialog, InlineAlert, Panel, StatusBadge, UiState } from '@opslog/ui';
import type { ApiError, BffRepairLink } from '@opslog/contracts';
import { errorKind } from '../maintenance/useResult';
import { BudgetPanel } from './BudgetPanel';
import { useIncidentEnv } from './context';
import { DateTime } from './DateTime';
import { RELOADED_COPY, describeError, isStale } from './errors';
import { ORDER_STATUS_LABELS } from './labelsCosts';
import { STATUS_TONES as ORDER_TONES } from '../maintenance/labels';
import { canLinkRepairs } from './model';
import { useOrderDraft } from './orderDraft';
import { RepairLinkForm } from './RepairLinkForm';
import { SubmitKeys, sendKeyed } from './submit';
import type { ChildProps } from './ThirdPartiesTab';
import { useLive } from './useLive';

const orderName = (link: BffRepairLink): string =>
  link.order.description?.trim()
    ? link.order.description.trim()
    : 'Orden correctiva sin descripción';

function unlinkCopy(error: ApiError): string {
  if (error.code === 'missing_requirements')
    return 'Esta orden es lo que sostiene el paso a reparación: vincula otra orden o sube un presupuesto revisado antes de quitarla.';
  return describeError(error, 'desvincular la orden');
}

/**
 * Reparación: the maintenance orders linked to the case (name, state and workshop, no amounts) and the budget
 * evidence. Passing to repair needs a linked order or a reviewed budget (ADR-0014); the next-step panel lists
 * what the server still lacks. Linking and unlinking follow the case's state as the server allows it.
 */
export function RepairTab({ incident, onVersion, onReload }: ChildProps) {
  const env = useIncidentEnv();
  const list = useLive(
    () => env.ports.repairs.list(incident.id),
    [env.ports, incident.id, incident.version],
    env.onExpired,
  );
  const [linking, setLinking] = React.useState(false);
  const [removing, setRemoving] = React.useState<BffRepairLink | null>(null);
  const [removeError, setRemoveError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const keys = React.useRef(new SubmitKeys());
  const draft = useOrderDraft(incident);
  const writable = canLinkRepairs(incident, env.permissions);

  if (list.data === null)
    return list.error ? (
      <UiState kind={errorKind(list.error)} actionLabel="Reintentar" onAction={list.reload} />
    ) : (
      <UiState kind="loading" />
    );

  const unlink = async (link: BffRepairLink) => {
    setBusy(true);
    setRemoveError(null);
    const body = { version: incident.version, linkId: link.id };
    const result = await sendKeyed(keys.current, [incident.id, 'unlink', body], (key) =>
      env.ports.repairs.unlink(incident.id, link.id, incident.version, key),
    );
    setBusy(false);
    if (result.ok) {
      setRemoving(null);
      onVersion(result.value.version, 'Orden desvinculada.');
      return;
    }
    if (result.error.status === 401) env.onExpired();
    if (isStale(result.error)) onReload();
    setRemoveError(isStale(result.error) ? RELOADED_COPY : unlinkCopy(result.error));
  };

  return (
    <>
      <Panel
        title="Órdenes de reparación"
        description="Las órdenes correctivas de mantenimiento que reparan este vehículo por este siniestro."
        actions={
          writable && !linking ? (
            <Button variant="contained" onClick={() => setLinking(true)}>
              Vincular orden
            </Button>
          ) : undefined
        }
      >
        {list.error && (
          <InlineAlert severity="error">No pudimos actualizar las órdenes vinculadas.</InlineAlert>
        )}
        {linking && (
          <RepairLinkForm
            incident={incident}
            links={list.data.items}
            draft={draft}
            onLinked={(version, message) => {
              draft.reset();
              setLinking(false);
              onVersion(version, message);
            }}
            onReload={onReload}
            onClose={() => setLinking(false)}
          />
        )}
        {list.data.items.length === 0 ? (
          <UiState
            kind="empty"
            title="Sin órdenes vinculadas"
            description={
              writable
                ? 'Vincula una orden correctiva o sube un presupuesto para pasar a reparación.'
                : 'Cuando se vincule una orden aparecerá aquí.'
            }
          />
        ) : (
          <Box
            component="ul"
            aria-label="Órdenes vinculadas"
            sx={{ display: 'grid', gap: 1.5, p: 0, m: 0 }}
          >
            {list.data.items.map((link) => (
              <Box
                component="li"
                key={link.id}
                sx={{
                  listStyle: 'none',
                  border: 1,
                  borderColor: 'divider',
                  borderRadius: 2,
                  p: 1.5,
                  display: 'flex',
                  gap: 1.5,
                  flexWrap: 'wrap',
                  alignItems: 'center',
                }}
              >
                <Box sx={{ flex: 1, minWidth: 200 }}>
                  <Typography sx={{ overflowWrap: 'anywhere', fontWeight: 500 }}>
                    {orderName(link)}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Taller: {link.order.workshop ?? 'Sin taller'} · vinculada por{' '}
                    {link.linkedBy.displayName} el <DateTime value={link.linkedAt} />
                  </Typography>
                </Box>
                <StatusBadge
                  label={ORDER_STATUS_LABELS[link.order.status]}
                  tone={ORDER_TONES[link.order.status]}
                />
                {writable && (
                  <Button
                    variant="text"
                    color="error"
                    onClick={() => {
                      setRemoveError(null);
                      setRemoving(link);
                    }}
                  >
                    {`Desvincular ${orderName(link)}`}
                  </Button>
                )}
              </Box>
            ))}
          </Box>
        )}
        {incident.status === 'repair' && list.data.items.length > 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
            Para marcar el caso como resuelto, las órdenes vinculadas deben estar terminadas.
          </Typography>
        )}
      </Panel>
      <BudgetPanel incident={incident} />
      {removing && (
        <ConfirmDialog
          title="Desvincular orden"
          description="La orden sigue existiendo en mantenimiento; solo deja de contar para este siniestro."
          confirmLabel="Desvincular"
          busy={busy}
          {...(removeError ? { error: removeError } : {})}
          onConfirm={() => void unlink(removing)}
          onCancel={() => setRemoving(null)}
        />
      )}
    </>
  );
}
