import type { BffWorkOrder, BffWorkOrderCommand } from '@opslog/contracts';
import { requirementLabel } from './labels';

/** What the screen knows about the caller: session grants and their own mechanic records. */
export interface MaintenanceViewer {
  readonly permissions: readonly string[];
  readonly mechanicIds: readonly string[];
}

const has = (viewer: MaintenanceViewer, permission: string) =>
  viewer.permissions.includes(permission);
export const isAssignedTo = (viewer: MaintenanceViewer, order: BffWorkOrder): boolean =>
  order.mechanicId !== null && viewer.mechanicIds.includes(order.mechanicId);

/**
 * Commands to offer for SPECS §6.1, mirroring the server's matrix. The server stays the authority:
 * a refused command comes back as an error or as missing requirements, never as a local rule.
 * `approve_close` is offered to an approver while a completed order has no approval; when the
 * tenant has no D20 threshold the server refuses it and the screen shows that refusal.
 */
export function availableCommands(
  order: BffWorkOrder,
  viewer: MaintenanceViewer,
): BffWorkOrderCommand[] {
  const fleet = has(viewer, 'edit');
  const assigned = isAssignedTo(viewer, order);
  const commands: BffWorkOrderCommand[] = [];
  switch (order.status) {
    case 'scheduled':
      if (fleet) commands.push('assign');
      break;
    case 'assigned':
      if (fleet || assigned) commands.push('start');
      break;
    case 'in_progress':
      if (fleet || assigned) commands.push('complete');
      break;
    case 'completed':
      if (has(viewer, 'incidents:approve') && !order.closeApproval) commands.push('approve_close');
      if (fleet && has(viewer, 'view_costs')) commands.push('close');
      break;
    case 'closed':
      if (has(viewer, 'reopen')) commands.push('reopen');
      break;
    case 'cancelled':
      break;
  }
  if (fleet && ['scheduled', 'assigned', 'in_progress'].includes(order.status))
    commands.push('cancel');
  return commands;
}

export const canRecordWork = (order: BffWorkOrder, viewer: MaintenanceViewer): boolean =>
  ['scheduled', 'assigned', 'in_progress', 'completed'].includes(order.status) &&
  (has(viewer, 'edit') || (isAssignedTo(viewer, order) && order.status === 'in_progress'));
export const canRecordCosts = (order: BffWorkOrder, viewer: MaintenanceViewer): boolean =>
  ['scheduled', 'assigned', 'in_progress', 'completed'].includes(order.status) &&
  has(viewer, 'edit') &&
  has(viewer, 'view_costs');

const NEXT_STEP: Readonly<Record<BffWorkOrder['status'], string>> = {
  scheduled: 'Asigna responsable, taller o mecánico y fecha programada.',
  assigned: 'Inicia el trabajo cuando el vehículo llegue al taller.',
  in_progress: 'Registra los trabajos y termina con la fecha real y el kilometraje.',
  completed: 'Valida costos y requisitos, y cierra eligiendo el estado del vehículo.',
  closed: 'Orden cerrada: es historial y solo puede reabrirse con un motivo.',
  cancelled: 'Orden cancelada: queda como historial con su trabajo registrado.',
};

/** Steps for `NextStepPanel`: the structured requirements the server reported, else the next action. */
export function nextSteps(order: BffWorkOrder, missing: readonly string[]): string[] {
  if (missing.length > 0) return missing.map(requirementLabel);
  const steps = [NEXT_STEP[order.status]];
  if (order.vehicleProposal)
    steps.push(
      'Sugerencia: el vehículo queda bloqueado para operar mientras esté en taller. Cambia su estado a «En mantenimiento» desde la ficha del vehículo si corresponde.',
    );
  return steps;
}
