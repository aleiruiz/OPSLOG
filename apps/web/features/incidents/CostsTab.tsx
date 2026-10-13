import React from 'react';
import Box from '@mui/material/Box';
import { Button, InlineAlert, UiState } from '@opslog/ui';
import { errorKind } from '../maintenance/useResult';
import { CostApproval } from './CostApproval';
import { CostLines } from './CostLines';
import { CostReference } from './CostReference';
import { CostSnapshots } from './CostSnapshots';
import { CostRepairs, CostTotals } from './CostTotals';
import { useIncidentEnv } from './context';
import {
  NO_EDITS,
  costsInput,
  estimateProblem,
  isDirty,
  reconcile,
  workingLines,
  type CostEdits,
} from './costsModel';
import { STALE_COPY, describeError, isStale } from './errors';
import { canEditCosts, mayViewCosts } from './model';
import { SubmitKeys, sendKeyed } from './submit';
import type { ChildProps } from './ThirdPartiesTab';
import { useLive } from './useLive';

/**
 * Costos (US-034): totals per currency, the case's own lines, the reference estimate and deductible, the
 * approval state (D20) and the cost at each closing. Only for `incidents:view_costs`: without it nothing is
 * requested and nothing is drawn. What the person changed stays on screen until one save sends it all.
 */
export function CostsTab(props: ChildProps & { approvalPending: boolean }) {
  const env = useIncidentEnv();
  if (!mayViewCosts(env.permissions)) return <UiState kind="no-permission" />;
  return <CostsContent {...props} />;
}

function CostsContent({
  incident,
  onVersion,
  onReload,
  approvalPending,
}: ChildProps & { approvalPending: boolean }) {
  const env = useIncidentEnv();
  const costs = useLive(
    () => env.ports.costs.get(incident.id),
    [env.ports, incident.id, incident.version],
    env.onExpired,
  );
  const links = useLive(
    () => env.ports.repairs.list(incident.id),
    [env.ports, incident.id, incident.version],
    env.onExpired,
  );
  const [staged, setStaged] = React.useState<CostEdits>(NO_EDITS);
  const [problem, setProblem] = React.useState<{ message: string; stale: boolean } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const keys = React.useRef(new SubmitKeys());

  if (costs.data === null)
    return costs.error ? (
      <UiState kind={errorKind(costs.error)} actionLabel="Reintentar" onAction={costs.reload} />
    ) : (
      <UiState kind="loading" />
    );

  const data = costs.data;
  const edits = reconcile(staged, data.lines);
  const editable = canEditCosts(incident, env.permissions);
  const lines = workingLines(data.lines, edits);
  const defaultCurrency = data.totals[0]?.currency ?? data.initialEstimate?.currency ?? 'MXN';
  const dirty = isDirty(edits);

  const save = async () => {
    if (busy) return;
    if (edits.estimate && estimateProblem(edits.estimate)) {
      setProblem({ message: estimateProblem(edits.estimate) as string, stale: false });
      return;
    }
    setBusy(true);
    setProblem(null);
    const body = costsInput(incident.version, data.lines, edits);
    const result = await sendKeyed(keys.current, [incident.id, 'costs', body], (key) =>
      env.ports.costs.update(incident.id, body, key),
    );
    setBusy(false);
    if (result.ok) {
      setStaged(NO_EDITS);
      costs.set(result.value);
      onVersion(result.value.version, 'Costos guardados.');
      return;
    }
    if (result.error.status === 401) env.onExpired();
    setProblem(
      isStale(result.error)
        ? { message: STALE_COPY, stale: true }
        : { message: describeError(result.error, 'guardar los costos'), stale: false },
    );
  };

  return (
    <Box sx={{ display: 'grid', gap: 0, gridTemplateColumns: 'minmax(0, 1fr)' }}>
      {(costs.error || links.error) && (
        <InlineAlert severity="warning">
          No pudimos actualizar los costos. Lo que ves puede estar desfasado.
        </InlineAlert>
      )}
      {problem && (
        <InlineAlert
          severity={problem.stale ? 'warning' : 'error'}
          {...(problem.stale
            ? {
                action: (
                  <Button
                    color="inherit"
                    onClick={() => {
                      setProblem(null);
                      onReload();
                    }}
                  >
                    Recargar
                  </Button>
                ),
              }
            : {})}
        >
          {problem.message}
        </InlineAlert>
      )}
      <CostTotals costs={data} />
      <CostApproval incident={incident} pending={approvalPending} />
      <CostRepairs costs={data} links={links.data?.items ?? []} />
      <CostLines
        lines={lines}
        edits={edits}
        editable={editable}
        defaultCurrency={defaultCurrency}
        onEdits={setStaged}
      />
      <CostReference
        costs={data}
        edits={edits}
        editable={editable}
        defaultCurrency={defaultCurrency}
        onEdits={setStaged}
      />
      {editable && (
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mb: 3 }}>
          <Button variant="contained" loading={busy} disabled={!dirty} onClick={() => void save()}>
            Guardar costos
          </Button>
          {dirty && (
            <Button
              variant="text"
              onClick={() => {
                setStaged(NO_EDITS);
                setProblem(null);
              }}
            >
              Descartar cambios
            </Button>
          )}
        </Box>
      )}
      <CostSnapshots snapshots={data.snapshots} />
    </Box>
  );
}
