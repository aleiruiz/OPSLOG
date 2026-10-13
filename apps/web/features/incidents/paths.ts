export const incidentsPath = '/incidents';
export const newIncidentPath = '/incidents/new';
/** The caller's SLA notices (INC-SLA) and the incident settings, as their own addresses. */
export const alertsPath = '/incidents/avisos';
export const settingsPath = '/incidents/configuracion';
export const incidentPath = (id: string, tab?: string): string =>
  `/incidents/${encodeURIComponent(id)}${tab ? `/${encodeURIComponent(tab)}` : ''}`;
/** The wizard of a draft: the draft and the step live in the address, so a reload resumes them. */
export const draftPath = (id: string, step: number): string =>
  `${newIncidentPath}?borrador=${encodeURIComponent(id)}&paso=${step}`;

export const TAB_IDS = [
  'summary',
  'third-parties',
  'evidence',
  'insurance',
  'repair',
  'costs',
  'timeline',
] as const;
export type TabId = (typeof TAB_IDS)[number];
export const TAB_LABELS: Readonly<Record<TabId, string>> = {
  summary: 'Resumen',
  'third-parties': 'Terceros',
  evidence: 'Evidencia',
  insurance: 'Seguro',
  repair: 'Reparación',
  costs: 'Costos',
  timeline: 'Timeline',
};
/** The tabs a caller gets: Costos only with `incidents:view_costs` (the others follow `incidents:view`). */
export const tabsFor = (viewCosts: boolean): readonly TabId[] =>
  TAB_IDS.filter((id) => id !== 'costs' || viewCosts);
export const asTab = (value: string | undefined, viewCosts = false): TabId =>
  tabsFor(viewCosts).find((id) => id === value) ?? 'summary';
