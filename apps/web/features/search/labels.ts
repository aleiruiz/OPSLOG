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
  all: 'Ver todos los resultados',
  title: 'Resultados de búsqueda',
} as const;

export const MIN_SEARCH_LENGTH = 2;

export const resultsPath = (q: string): string => `/buscar?q=${encodeURIComponent(q)}`;

/** Announcement for assistive technology after each search. */
export function resultsAnnouncement(total: number): string {
  if (total === 0) return searchCopy.empty;
  return total === 1 ? '1 resultado.' : `${total} resultados.`;
}
