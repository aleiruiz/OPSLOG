import type { ApiError, BffViewDrop } from '@opslog/contracts';

/** Spanish sentence for a failed saved-view action; never shows ids or server text. */
export function viewErrorText(error: ApiError): string {
  switch (error.code) {
    case 'duplicate':
      return 'Ya tienes una vista con ese nombre en este listado.';
    case 'rule_violation':
      return 'Llegaste al límite de 50 vistas en este listado. Elimina alguna para guardar otra.';
    case 'stale_version':
      return 'Alguien más cambió esta vista. Se recargó la lista: revisa y vuelve a intentarlo.';
    case 'not_found':
      return 'Esa vista ya no existe. Se actualizó la lista.';
    case 'forbidden':
      return 'No tienes permiso para cambiar esta vista.';
    case 'bad_request':
      return 'Revisa el nombre de la vista: no puede estar vacío ni pasar de 80 caracteres.';
    default:
      return 'No pudimos completar la acción con la vista. Intenta de nuevo.';
  }
}

/** The notice shown when a view asked for something this reader cannot use (it was left out). */
export function dropNotice(dropped: readonly BffViewDrop[]): string | null {
  if (dropped.length === 0) return null;
  const names = [...new Set(dropped.map((drop) => drop.label))].join(', ');
  return `Se omitió lo que no puedes usar o ya no existe: ${names}.`;
}
