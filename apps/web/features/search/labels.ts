import type { BffSearchType } from '@opslog/contracts';

export const searchTypeLabels: Readonly<Record<BffSearchType, string>> = {
  vehicle: 'Vehículos',
  driver: 'Conductores',
  dispatcher: 'Despachadores',
  incident: 'Incidentes',
  policy: 'Pólizas',
};

export const searchCopy = {
  label: 'Buscar',
  placeholder: 'Buscar placa, folio, nombre o póliza',
  hint: 'Escribe al menos 2 caracteres.',
  loading: 'Buscando…',
  empty: 'No encontramos resultados.',
  error: 'No pudimos buscar. Intenta nuevamente.',
  busy: 'La búsqueda está saturada en este momento. Espera unos segundos e intenta de nuevo.',
  all: 'Ver todos los resultados',
  title: 'Resultados de búsqueda',
} as const;

/** Friendly text of a failed search: a 503 is load, so it asks to wait and retry. */
export const searchErrorMessage = (error: { readonly status: number }): string =>
  error.status === 503 ? searchCopy.busy : searchCopy.error;

export const MIN_SEARCH_LENGTH = 2;

export const resultsPath = (q: string): string => `/buscar?q=${encodeURIComponent(q)}`;

/** Announcement for assistive technology after each search. */
export function resultsAnnouncement(total: number): string {
  if (total === 0) return searchCopy.empty;
  return total === 1 ? '1 resultado.' : `${total} resultados.`;
}
