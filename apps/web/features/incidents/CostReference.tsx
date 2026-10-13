import React from 'react';
import { DescriptionList, Field, InlineAlert, Panel } from '@opslog/ui';
import type { BffIncidentCosts } from '@opslog/contracts';
import { amountText, formatMoney } from './money';
import { deductibleText } from './labelsCosts';
import { estimateProblem, type CostEdits } from './costsModel';

/**
 * Referencias: the initial estimate (informative, outside every total) and the deductible the policy of the
 * case states. A percentage deductible is shown as insurance keeps it, never turned into an amount.
 */
export function CostReference({
  costs,
  edits,
  editable,
  defaultCurrency,
  onEdits,
}: {
  costs: BffIncidentCosts;
  edits: CostEdits;
  editable: boolean;
  defaultCurrency: string;
  onEdits: (next: CostEdits) => void;
}) {
  const id = React.useId();
  const { initialEstimate } = costs;
  const draft = edits.estimate;
  const amount = draft
    ? draft.amount
    : initialEstimate
      ? amountText(initialEstimate.amountMinor, initialEstimate.currency)
      : '';
  const currency = draft ? draft.currency : (initialEstimate?.currency ?? defaultCurrency);
  const problem = draft ? estimateProblem(draft) : null;
  const stage = (next: { amount: string; currency: string }) =>
    onEdits({
      ...edits,
      // Typing nothing clears the estimate; the server keeps it only when a value is sent.
      estimate:
        next.amount.trim() === '' && initialEstimate === null
          ? undefined
          : next.amount.trim() === ''
            ? null
            : next,
    });
  return (
    <Panel
      title="Estimación y deducible"
      description="Son solo de referencia: no entran en los totales."
    >
      {editable ? (
        <>
          <Field
            id={`${id}-estimate`}
            label="Estimación inicial"
            value={amount}
            inputProps={{ inputMode: 'decimal' }}
            description="Déjala vacía para no registrar una estimación."
            error={problem !== null}
            {...(problem ? { helperText: problem } : {})}
            onChange={(event) => stage({ amount: event.target.value, currency })}
          />
          <Field
            id={`${id}-estimate-currency`}
            label="Moneda de la estimación"
            value={currency}
            onChange={(event) => stage({ amount, currency: event.target.value.toUpperCase() })}
          />
        </>
      ) : (
        <DescriptionList
          items={[
            {
              label: 'Estimación inicial',
              value: initialEstimate ? formatMoney(initialEstimate) : 'Sin estimación',
            },
          ]}
        />
      )}
      <DescriptionList
        items={[
          {
            label: 'Deducible de la póliza',
            value: costs.policyDeductible
              ? deductibleText(costs.policyDeductible)
              : 'Sin póliza o sin deducible registrado',
          },
        ]}
      />
      {edits.estimate !== undefined && edits.estimate !== null && problem === null && (
        <InlineAlert severity="info">La estimación se guardará con los demás cambios.</InlineAlert>
      )}
    </Panel>
  );
}
