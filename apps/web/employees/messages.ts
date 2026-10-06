import type { ApiError } from '../app/types';
import type { FieldErrors, FormMode } from './formModel';
import { duplicateErrors } from './formModel';

export interface FormAlert {
  /** Errors use the recoverable-error state (with an optional action); the others are plain notices. */
  readonly severity: 'error' | 'warning' | 'info';
  readonly title?: string;
  readonly message: string;
  /** Recovery action next to the message, for example "Cargar datos actuales". */
  readonly actionLabel?: string;
}

export interface Failure {
  readonly alert: FormAlert | null;
  readonly fields: FieldErrors;
}

export const RELOAD = 'Cargar datos actuales';

const fail = (title: string, message: string, actionLabel?: string): FormAlert => ({
  severity: 'error',
  title,
  message,
  ...(actionLabel ? { actionLabel } : {}),
});

/** Maps a failed save to what the person sees: field messages, an alert, or (401) nothing at all. */
export function describeFailure(error: ApiError, mode: FormMode): Failure {
  if (error.status === 401) return { alert: null, fields: {} };
  const kept = mode === 'create' ? 'No se creó el empleado.' : 'Tus cambios no se guardaron.';
  if (error.code === 'stale_version')
    return {
      alert: fail(
        'Otra persona modificó este empleado',
        `Cambió mientras lo editabas. ${kept} Carga los datos actuales y vuelve a hacer tus cambios.`,
        RELOAD,
      ),
      fields: {},
    };
  if (error.code === 'immutable')
    return {
      alert: fail(
        'El empleado ya no admite cambios',
        `Se dio de baja o se archivó mientras lo editabas. ${kept}`,
      ),
      fields: {},
    };
  if (error.code === 'duplicate')
    return {
      alert: fail(
        'Hay datos que ya existen',
        'Otro empleado de tu empresa usa el mismo valor. Corrige los campos marcados.',
      ),
      fields: duplicateErrors(error),
    };
  if (error.code === 'invalid_area')
    return {
      alert: fail(
        'El área no es válida',
        'El área no existe o está inactiva. Elige un área activa de tu empresa.',
      ),
      fields: { areaId: 'El área no existe o está inactiva.' },
    };
  if (error.status === 400)
    return {
      alert: fail(
        'El servidor rechazó los datos',
        `Revisa todos los campos e intenta de nuevo. ${kept}`,
      ),
      fields: {},
    };
  if (error.status === 403)
    return {
      alert: fail(
        'No tienes permiso',
        'Tu rol no permite guardar estos cambios. Los datos personales solo los puede guardar quien tiene permiso para verlos.',
      ),
      fields: {},
    };
  if (error.status === 404)
    return { alert: fail('El empleado ya no existe', 'No se guardó ningún cambio.'), fields: {} };
  return {
    alert: fail(
      mode === 'create' ? 'No pudimos crear el empleado' : 'No pudimos guardar el empleado',
      'Intenta nuevamente.',
    ),
    fields: {},
  };
}

export interface ActionFailure {
  readonly error: string;
  readonly errorActionLabel?: string;
}

const RELOAD_DATA = 'Recargar datos';
const STALE =
  'Otra persona modificó este empleado mientras lo revisabas. Recarga los datos y vuelve a decidir.';

/** A failed archive from the confirmation dialog. */
export function archiveFailure(error: ApiError): ActionFailure {
  if (error.code === 'stale_version') return { error: STALE, errorActionLabel: RELOAD_DATA };
  if (error.code === 'immutable')
    return { error: 'Este empleado ya estaba archivado.', errorActionLabel: RELOAD_DATA };
  if (error.status === 403) return { error: 'No tienes permiso para archivar empleados.' };
  if (error.status === 404) return { error: 'Este empleado ya no existe.' };
  return { error: 'No pudimos archivar al empleado. Intenta nuevamente.' };
}

/** A failed status change; shown in the panel (or, for a termination, inside the confirmation dialog). */
export function statusFailure(error: ApiError): ActionFailure {
  if (error.code === 'stale_version') return { error: STALE, errorActionLabel: RELOAD_DATA };
  if (error.code === 'invalid_transition')
    return {
      error:
        'Ese cambio de estado ya no es posible: el empleado cambió de estado mientras lo revisabas.',
      errorActionLabel: RELOAD_DATA,
    };
  if (error.code === 'immutable')
    return {
      error: 'El empleado se archivó o se dio de baja mientras lo revisabas: ya no admite cambios.',
      errorActionLabel: RELOAD_DATA,
    };
  if (error.status === 400)
    return { error: 'El servidor rechazó el motivo. Revísalo e intenta de nuevo.' };
  if (error.status === 403)
    return { error: 'No tienes permiso para cambiar el estado de empleados.' };
  if (error.status === 404) return { error: 'Este empleado ya no existe.' };
  return { error: 'No pudimos cambiar el estado. Intenta nuevamente.' };
}
