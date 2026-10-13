export const incidentsPath = '/incidents';
export const newIncidentPath = '/incidents/new';
export const incidentPath = (id: string, tab?: string): string =>
  `/incidents/${encodeURIComponent(id)}${tab ? `/${encodeURIComponent(tab)}` : ''}`;
/** The wizard of a draft: the draft and the step live in the address, so a reload resumes them. */
export const draftPath = (id: string, step: number): string =>
  `${newIncidentPath}?borrador=${encodeURIComponent(id)}&paso=${step}`;

export const TAB_IDS = ['summary', 'third-parties', 'evidence', 'insurance', 'timeline'] as const;
export type TabId = (typeof TAB_IDS)[number];
export const TAB_LABELS: Readonly<Record<TabId, string>> = {
  summary: 'Resumen',
  'third-parties': 'Terceros',
  evidence: 'Evidencia',
  insurance: 'Seguro',
  timeline: 'Timeline',
};
export const asTab = (value: string | undefined): TabId =>
  TAB_IDS.find((id) => id === value) ?? 'summary';
