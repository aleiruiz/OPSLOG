import React from 'react';
import Typography from '@mui/material/Typography';
import type { BffIncident, BffIncidentInsuranceInput } from '@opslog/contracts';
import { DescriptionList, Field, InlineAlert, Panel } from '@opslog/ui';
import { useIncidentEnv } from './env';
import type { SubmitOutcome } from './EventForm';
import { INSURER_RESULT_LABELS } from './labels';
import { canEditInsurance } from './model';
import { outcomeOf } from './outcome';
import { RecordForm, type FieldSpec } from './RecordForm';
import { formatDay } from './time';
import type { CaseProps } from './SummaryTab';
import { useSuggestions } from './useIncident';

const FIELDS: readonly FieldSpec[] = [
  { key: 'insurerName', label: 'Aseguradora', kind: 'text' },
  { key: 'claimNumber', label: 'Número de siniestro de la aseguradora', kind: 'text' },
  { key: 'adjusterName', label: 'Ajustador', kind: 'text' },
  { key: 'adjusterContact', label: 'Contacto del ajustador', kind: 'text' },
  {
    key: 'insurerReportedOn',
    label: 'Día en que se avisó a la aseguradora',
    kind: 'date',
    description: 'No puede ser futuro ni anterior al evento.',
  },
  {
    key: 'insurerResult',
    label: 'Resultado de la aseguradora',
    kind: 'select',
    empty: 'Sin resultado',
    options: Object.entries(INSURER_RESULT_LABELS).map(([value, label]) => ({ value, label })),
  },
];

const TEXT_KEYS = ['insurerName', 'claimNumber', 'adjusterName', 'adjusterContact'] as const;

/** Copy for the coverage found at the event day. It never says the company lacks legal coverage. */
function CoverageNotice({ incident }: { incident: BffIncident }) {
  const { status } = incident.coverage;
  if (status === 'none')
    return (
      <InlineAlert severity="warning">
        Sin póliza registrada vigente a la fecha del evento
      </InlineAlert>
    );
  if (status === 'multiple')
    return (
      <InlineAlert severity="info">
        Más de una póliza cubría el día del evento: elige cuál aplica al caso.
      </InlineAlert>
    );
  if (status === 'unknown')
    return (
      <InlineAlert severity="info">
        Indica la fecha y hora del evento para ubicar la póliza que lo cubría.
      </InlineAlert>
    );
  return null;
}

/** Seguro: the policy that covered the day of the event (frozen when linked) and the process with the insurer. */
export function InsuranceTab({ incident, onIncident, onReload }: CaseProps) {
  const env = useIncidentEnv();
  const { insurance, coverage } = incident;
  const editable = canEditInsurance(incident);
  const mayChoosePolicy = editable || incident.editableFields.includes('policyId');
  const suggestions = useSuggestions(
    coverage.status === 'multiple' ? incident.vehicle.id : null,
    incident.occurredAt,
  );
  const [policyError, setPolicyError] = React.useState<string | null>(null);
  const choose = async (policyId: string) => {
    setPolicyError(null);
    const result = editable
      ? await env.ports.updateInsurance(incident.id, { version: incident.version, policyId })
      : await env.ports.update(incident.id, { version: incident.version, policyId });
    const outcome = outcomeOf(
      result,
      env.onExpired,
      (next) => onIncident(next, 'Póliza elegida.'),
      'elegir la póliza',
    );
    if (!outcome.ok) setPolicyError(outcome.message);
  };
  const save = async (changed: Readonly<Record<string, string>>): Promise<SubmitOutcome> => {
    const body: Record<string, unknown> = { version: incident.version };
    for (const key of TEXT_KEYS)
      if (changed[key] !== undefined) body[key] = changed[key].trim() || null;
    if (changed['insurerReportedOn'] !== undefined)
      body['insurerReportedOn'] = changed['insurerReportedOn'] || null;
    if (changed['insurerResult'] !== undefined)
      body['insurerResult'] = changed['insurerResult'] || null;
    return outcomeOf(
      await env.ports.updateInsurance(incident.id, body as unknown as BffIncidentInsuranceInput),
      env.onExpired,
      (next) => onIncident(next, 'Datos del seguro guardados.'),
      'guardar los datos del seguro',
    );
  };
  const policy = coverage.policy;
  const reasons = [
    ...(insurance.rejectionReason
      ? [{ label: 'Motivo del rechazo', value: insurance.rejectionReason }]
      : []),
    ...(insurance.appealNote ? [{ label: 'Nota de apelación', value: insurance.appealNote }] : []),
    ...(insurance.noInsuranceReason
      ? [{ label: 'Por qué se sigue sin aseguradora', value: insurance.noInsuranceReason }]
      : []),
  ];
  return (
    <>
      <Panel title="Póliza vigente a la fecha del evento">
        <CoverageNotice incident={incident} />
        {policy && (
          <DescriptionList
            items={[
              { label: 'Aseguradora', value: policy.insurer },
              { label: 'Número de póliza', value: policy.policyNumber },
              { label: 'Tipo de cobertura', value: policy.coverageType },
              {
                label: 'Vigencia',
                value: `${formatDay(policy.startsOn)} al ${formatDay(policy.endsOn)}`,
              },
            ]}
          />
        )}
        {coverage.status === 'multiple' && mayChoosePolicy && suggestions && (
          <Field
            id="insurance-policy"
            label="Póliza que aplica"
            select
            SelectProps={{ native: true }}
            InputLabelProps={{ shrink: true }}
            value={policy?.policyId ?? ''}
            onChange={(event) => {
              if (event.target.value) void choose(event.target.value);
            }}
          >
            <option value="">Elige una póliza</option>
            {suggestions.policies.map((item) => (
              <option key={item.policyId} value={item.policyId}>
                {`${item.insurer} · póliza ${item.policyNumber} (${formatDay(item.startsOn)} al ${formatDay(item.endsOn)})`}
              </option>
            ))}
          </Field>
        )}
        {policyError && <InlineAlert severity="error">{policyError}</InlineAlert>}
      </Panel>
      <Panel
        title="Proceso con la aseguradora"
        {...(editable
          ? {}
          : {
              description:
                'Estos datos se capturan desde que el caso está en revisión. Aquí se muestran solo de lectura.',
            })}
      >
        <DescriptionList
          items={[
            { label: 'Aseguradora', value: insurance.insurerName ?? 'Sin dato' },
            { label: 'Número de siniestro', value: insurance.claimNumber ?? 'Sin dato' },
            { label: 'Ajustador', value: insurance.adjusterName ?? 'Sin dato' },
            { label: 'Contacto del ajustador', value: insurance.adjusterContact ?? 'Sin dato' },
            { label: 'Aviso a la aseguradora', value: formatDay(insurance.insurerReportedOn) },
            {
              label: 'Resultado',
              value: insurance.insurerResult
                ? INSURER_RESULT_LABELS[insurance.insurerResult]
                : 'Sin resultado',
            },
            ...reasons,
          ]}
        />
        {editable ? (
          <RecordForm
            label="Editar datos del seguro"
            fields={FIELDS}
            base={{
              insurerName: insurance.insurerName ?? '',
              claimNumber: insurance.claimNumber ?? '',
              adjusterName: insurance.adjusterName ?? '',
              adjusterContact: insurance.adjusterContact ?? '',
              insurerReportedOn: insurance.insurerReportedOn ?? '',
              insurerResult: insurance.insurerResult ?? '',
            }}
            submitLabel="Guardar datos del seguro"
            onSubmit={save}
            onReload={onReload}
          />
        ) : (
          incident.status === 'closed' && (
            <Typography color="text.secondary">
              El caso está cerrado: estos datos son historial. Para corregirlos hay que reabrirlo.
            </Typography>
          )
        )}
      </Panel>
    </>
  );
}
