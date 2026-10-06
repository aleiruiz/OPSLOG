import type { ApiError } from '../app/types';
import type { FieldErrors, FormMode } from './formModel';

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

/** The colliding field of a 409 `duplicate`: only its name comes back, never the value. */
export function duplicateErrors(error: ApiError): FieldErrors {
  const errors: FieldErrors = {};
  for (const item of error.fieldErrors ?? []) {
    if (item.field === 'name')
      errors.name = 'Ya existe otra área con este nombre dentro de la misma área superior.';
    if (item.field === 'code') errors.code = 'Ya existe un área con este código en tu empresa.';
  }
  return errors;
}

const subject: Record<FormMode, string> = {
  create: 'crear el área',
  edit: 'guardar el área',
  move: 'mover el área',
};

/** Maps a failed save to what the person sees: field messages, an alert, or (401) nothing at all. */
export function describeFailure(error: ApiError, mode: FormMode): Failure {
  if (error.status === 401) return { alert: null, fields: {} };
  const kept = mode === 'create' ? 'No se creó el área.' : 'Tus cambios no se guardaron.';
  if (error.code === 'stale_version')
    return {
      alert: fail(
        'Otra persona modificó esta área',
        `Cambió mientras la editabas. ${kept} Carga los datos actuales y vuelve a hacer tus cambios.`,
        RELOAD,
      ),
      fields: {},
    };
  if (error.code === 'immutable')
    return {
      alert: fail(
        'El área ya no admite cambios',
        'Se desactivó mientras la editabas. Un área inactiva es de solo lectura hasta que se vuelve a activar.',
      ),
      fields: {},
    };
  if (error.code === 'duplicate' && mode === 'move')
    return {
      alert: fail(
        'Ya hay un área con ese nombre allí',
        `Otra área de la ubicación elegida se llama igual. ${kept} Elige otra área superior o cambia primero el nombre.`,
      ),
      fields: { parentId: 'Ya existe un área con este nombre dentro de esa área superior.' },
    };
  if (error.code === 'duplicate')
    return {
      alert: fail(
        'Hay datos que ya existen',
        'Otra área de tu empresa usa el mismo valor. Corrige los campos marcados.',
      ),
      fields: duplicateErrors(error),
    };
  if (error.code === 'invalid_hierarchy')
    return {
      alert: fail(
        'Esa ubicación no es válida',
        `El área superior elegida ya no admite esta ubicación: puede estar inactiva, superar los 4 niveles o ser una sub-área de esta misma área. ${kept} Carga los datos actuales y elige otra.`,
        RELOAD,
      ),
      fields: { parentId: 'Elige otra área superior.' },
    };
  if (error.code === 'invalid_responsible')
    return {
      alert: fail(
        'Responsables no válidos',
        'Alguna persona responsable no es un miembro activo de tu empresa. Revisa los identificadores de la lista.',
      ),
      fields: {
        responsibles: 'Alguno de los identificadores no corresponde a un miembro activo.',
      },
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
      alert: fail('No tienes permiso', 'Tu rol no permite guardar cambios en áreas.'),
      fields: {},
    };
  if (error.status === 404)
    return { alert: fail('El área ya no existe', 'No se guardó ningún cambio.'), fields: {} };
  return {
    alert: fail(`No pudimos ${subject[mode]}`, 'Intenta nuevamente.'),
    fields: {},
  };
}

export interface ActionFailure {
  readonly error: string;
  readonly errorActionLabel?: string;
}

const RELOAD_DATA = 'Recargar datos';

const blockers: Record<string, string> = {
  sub_areas: 'todavía tiene sub-áreas activas. Desactívalas o muévelas a otra área primero.',
  vehicles: 'todavía tiene vehículos activos asignados. Reasígnalos a otra área primero.',
  people: 'todavía tiene personas activas asignadas. Reasígnalas a otra área primero.',
};

/** What blocks a deactivation (409 `area_in_use`): the kind of resource, as the server names it. */
export function blockerOf(error: ApiError): string | null {
  return error.code === 'area_in_use' ? (error.fieldErrors?.[0]?.field ?? '') : null;
}

export function deactivateFailure(error: ApiError): ActionFailure {
  const blocker = blockerOf(error);
  if (blocker !== null)
    return {
      error: `No se puede desactivar: esta área ${blockers[blocker] ?? 'todavía tiene recursos activos asignados.'}`,
      errorActionLabel: RELOAD_DATA,
    };
  if (error.code === 'stale_version')
    return {
      error:
        'Otra persona modificó esta área mientras la revisabas. Recarga los datos y vuelve a decidir.',
      errorActionLabel: RELOAD_DATA,
    };
  if (error.code === 'invalid_transition')
    return { error: 'Esta área ya estaba inactiva.', errorActionLabel: RELOAD_DATA };
  if (error.status === 403) return { error: 'No tienes permiso para desactivar áreas.' };
  if (error.status === 404) return { error: 'Esta área ya no existe.' };
  return { error: 'No pudimos desactivar el área. Intenta nuevamente.' };
}

export function activateFailure(error: ApiError): ActionFailure {
  if (error.code === 'invalid_hierarchy')
    return {
      error:
        'No se puede activar: el área superior está inactiva. Actívala primero y vuelve a intentarlo.',
      errorActionLabel: RELOAD_DATA,
    };
  if (error.code === 'stale_version')
    return {
      error:
        'Otra persona modificó esta área mientras la revisabas. Recarga los datos y vuelve a decidir.',
      errorActionLabel: RELOAD_DATA,
    };
  if (error.code === 'invalid_transition')
    return { error: 'Esta área ya estaba activa.', errorActionLabel: RELOAD_DATA };
  if (error.status === 403) return { error: 'No tienes permiso para activar áreas.' };
  if (error.status === 404) return { error: 'Esta área ya no existe.' };
  return { error: 'No pudimos activar el área. Intenta nuevamente.' };
}
