import React from 'react';
import { DescriptionList, Panel } from '@opslog/ui';
import type { BffIncidentResolutionInput } from '@opslog/contracts';
import { DateTime } from './DateTime';
import { useIncidentEnv } from './env';
import type { SubmitOutcome } from './EventForm';
import { VEHICLE_DECISION_LABELS, YES_NO } from './labels';
import { canEditResolution } from './model';
import { outcomeOf } from './outcome';
import { RecordForm, type FieldSpec } from './RecordForm';
import type { CaseProps } from './SummaryTab';
import type { Approval } from './types';

const YES_NO_OPTIONS = [
  { value: 'yes', label: 'Sí' },
  { value: 'no', label: 'No' },
] as const;
const triState = (value: string, current: boolean | null): boolean | null =>
  value === '' ? null : value === 'yes' ? true : value === 'no' ? false : current;
const flag = (value: boolean | null): string => (value === null ? '' : value ? 'yes' : 'no');
const label = (value: boolean | null): string =>
  value === null ? YES_NO.unknown : value ? YES_NO.yes : YES_NO.no;

const FIELDS: readonly FieldSpec[] = [
  { key: 'resolutionSummary', label: 'Resumen de la resolución', kind: 'multiline' },
  { key: 'totalLoss', label: '¿Pérdida total?', kind: 'select', options: YES_NO_OPTIONS },
  {
    key: 'vehicleStatusDecision',
    label: 'Estado en que queda el vehículo',
    kind: 'select',
    empty: 'Elige un estado',
    options: Object.entries(VEHICLE_DECISION_LABELS).map(([value, text]) => ({
      value,
      label: text,
    })),
    description: 'Solo queda registrado: cambiar el estado del vehículo es una acción aparte.',
  },
  {
    key: 'costAssumed',
    label: '¿La empresa asume el costo?',
    kind: 'select',
    options: YES_NO_OPTIONS,
  },
];

function approval(prefix: string, value: Approval | null) {
  return value === null
    ? []
    : [
        {
          label: prefix,
          value: (
            <>
              {value.by.displayName} · <DateTime value={value.at} />
            </>
          ),
        },
      ];
}

/** Resolución: how the case ended, who approved and closed it, and the form while it can still change. */
export function ResolutionPanel({ incident, onIncident, onReload }: CaseProps) {
  const env = useIncidentEnv();
  const { resolution, insurance } = incident;
  const editable = canEditResolution(incident);
  const decision = resolution.vehicleStatusDecision;
  const recorded =
    resolution.resolutionSummary !== null ||
    decision !== null ||
    resolution.totalLoss !== null ||
    insurance.costAssumed !== null ||
    resolution.cancelReason !== null ||
    resolution.closedAt !== null;
  if (!editable && !recorded) return null;
  const base = {
    resolutionSummary: resolution.resolutionSummary ?? '',
    totalLoss: flag(resolution.totalLoss),
    vehicleStatusDecision: decision ?? '',
    costAssumed: flag(insurance.costAssumed),
  };
  const save = async (changed: Readonly<Record<string, string>>): Promise<SubmitOutcome> => {
    const body: Record<string, unknown> = { version: incident.version };
    if (changed['resolutionSummary'] !== undefined)
      body['resolutionSummary'] = changed['resolutionSummary'].trim() || null;
    if (changed['totalLoss'] !== undefined)
      body['totalLoss'] = triState(changed['totalLoss'], resolution.totalLoss);
    if (changed['vehicleStatusDecision'] !== undefined)
      body['vehicleStatusDecision'] = changed['vehicleStatusDecision'] || null;
    if (changed['costAssumed'] !== undefined)
      body['costAssumed'] = triState(changed['costAssumed'], insurance.costAssumed);
    return outcomeOf(
      await env.ports.updateResolution(incident.id, body as unknown as BffIncidentResolutionInput),
      env.onExpired,
      (next) => onIncident(next, 'Resolución guardada.'),
      'guardar la resolución',
    );
  };
  const items = [
    { label: 'Resumen de la resolución', value: resolution.resolutionSummary ?? 'Sin resumen' },
    { label: '¿Pérdida total?', value: label(resolution.totalLoss) },
    {
      label: 'Estado en que queda el vehículo',
      value:
        VEHICLE_DECISION_LABELS[decision as keyof typeof VEHICLE_DECISION_LABELS] ?? 'Sin decidir',
    },
    { label: '¿La empresa asume el costo?', value: label(insurance.costAssumed) },
    ...approval('Asunción del costo aprobada por', insurance.assumptionApproval),
    ...approval('Cierre aprobado por', resolution.closeApproval),
    ...(resolution.closedBy
      ? [
          {
            label: 'Cerrado por',
            value: (
              <>
                {resolution.closedBy.displayName} · <DateTime value={resolution.closedAt} />
              </>
            ),
          },
        ]
      : []),
    ...(resolution.cancelReason
      ? [{ label: 'Motivo de la cancelación', value: resolution.cancelReason }]
      : []),
  ];
  return (
    <Panel
      title="Resolución"
      {...(editable && (insurance.assumptionApproval || resolution.closeApproval)
        ? { description: 'Si cambias la resolución, las aprobaciones ya dadas se piden de nuevo.' }
        : {})}
    >
      <DescriptionList items={items} />
      {editable && (
        <RecordForm
          label="Editar resolución"
          fields={FIELDS}
          base={base}
          submitLabel="Guardar resolución"
          onSubmit={save}
          onReload={onReload}
        />
      )}
    </Panel>
  );
}
