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
  'history',
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
  history: 'Historial',
};
/**
 * The tabs a caller gets: Costos only with `incidents:view_costs`, Historial only with `view_audit`
 * (the others follow `incidents:view`).
 */
export const tabsFor = (viewCosts: boolean, viewAudit = false): readonly TabId[] =>
  TAB_IDS.filter((id) => (id !== 'costs' || viewCosts) && (id !== 'history' || viewAudit));
export const asTab = (value: string | undefined, viewCosts = false, viewAudit = false): TabId =>
  tabsFor(viewCosts, viewAudit).find((id) => id === value) ?? 'summary';
