import type { ApiError } from '@opslog/contracts';
import { FIELD_LABELS } from './labels';

/** Business rules of the server (field of a `rule_violation`), as instructions. Unknown rules get a neutral line. */
const RULE_COPY: Readonly<Record<string, string>> = {
  occurred_at_in_future: 'La fecha y hora del evento no pueden ser futuras.',
  occurred_before_vehicle_registration: 'El evento es anterior al registro del vehículo.',
  policy_not_covering_event_day: 'La póliza elegida no cubría el día del evento.',
  responsible_not_eligible: 'Esa persona no puede ser responsable de siniestros.',
  vehicle_blocked: 'Otra causa mantiene al vehículo fuera de servicio: no puede quedar Activo.',
  insurer_reported_on_in_future: 'El día del aviso a la aseguradora no puede ser futuro.',
  insurer_reported_on_before_event: 'El aviso a la aseguradora no puede ser anterior al evento.',
  third_party_limit_reached: 'El caso ya tiene el máximo de terceros permitido.',
  evidence_limit_reached: 'El caso ya tiene el máximo de archivos permitido.',
  repair_order_or_budget:
    'Este presupuesto sostiene el paso a reparación: sube otro o vincula una orden antes de quitarlo.',
};

export const STALE_COPY =
  'El caso cambió mientras lo editabas. Recarga para ver la versión actual: lo que escribiste y aún no enviaste se conserva.';

/**
 * Neutral Spanish copy for a failed request (SPECS §8): it never echoes server payloads, ids or values.
 * Only field names the screens know, and rule ids from the fixed list above, are turned into text.
 */
export function describeError(error: ApiError, action = 'completar la acción'): string {
  if (error.code === 'network_error')
    return 'No pudimos contactar al servidor. Revisa tu conexión.';
  switch (error.status) {
    case 400: {
      const names = (error.fieldErrors ?? [])
        .map((item) => FIELD_LABELS[item.field])
        .filter((name): name is string => name !== undefined);
      return names.length > 0
        ? `Revisa estos datos: ${[...new Set(names)].join(', ')}.`
        : 'Revisa los datos: alguno no es válido.';
    }
    case 403:
      return 'No tienes permiso para esta acción.';
    case 404:
      return 'No encontramos este registro. Puede que no exista o que no tengas acceso.';
    case 409:
      if (error.code === 'stale_version') return STALE_COPY;
      if (error.code === 'idempotency_conflict')
        return 'Esta solicitud ya se envió con otros datos. Recarga e intenta de nuevo.';
      if (error.code === 'duplicate') return 'Ese registro ya existe en el caso.';
      return 'El caso no admite esta acción en su estado actual.';
    case 422: {
      const rule = error.code === 'rule_violation' ? error.fieldErrors?.[0]?.field : undefined;
      if (rule !== undefined && RULE_COPY[rule] !== undefined) return RULE_COPY[rule];
      if (error.code === 'invalid_responsible')
        return RULE_COPY['responsible_not_eligible'] as string;
      if (error.code === 'missing_requirements') return 'Faltan requisitos para continuar.';
      return 'La regla del negocio no permite esta acción.';
    }
    default:
      return `No pudimos ${action}. Intenta nuevamente.`;
  }
}

export const isStale = (error: ApiError): boolean =>
  error.status === 409 && error.code === 'stale_version';
