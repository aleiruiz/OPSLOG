import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import {
  Button,
  DescriptionList,
  InlineAlert,
  NextStepPanel,
  PageHeader,
  Panel,
  UiState,
  Wizard,
} from '@opslog/ui';
import type { BffIncident } from '@opslog/contracts';
import { BackLink } from '../../app/BackLink';
import { useRouter } from '../../app/router';
import { errorKind } from '../maintenance/useResult';
import { DateTime } from './DateTime';
import { useIncidentEnv } from './context';
import { EventForm, type SubmitOutcome } from './EventForm';
import type { EventFields } from './eventEdits';
import { EvidenceTab } from './EvidenceTab';
import { STALE_COPY, describeError, isStale } from './errors';
import { TYPE_LABELS } from './labels';
import { missingLines, stepViews } from './model';
import { outcomeOf } from './outcome';
import { draftPath, incidentPath, incidentsPath } from './paths';
import { SubmitKeys, sendKeyed } from './submit';
import { ThirdPartiesTab } from './ThirdPartiesTab';
import { useSuggestions } from './useIncident';
import { useLive } from './useLive';

export const WIZARD_STEPS = [
  'Evento',
  'Conductor y póliza',
  'Terceros',
  'Evidencia',
  'Resumen',
] as const;
const LAST = WIZARD_STEPS.length - 1;

const clamp = (value: string | null, hasDraft: boolean): number => {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!hasDraft || Number.isNaN(parsed)) return 0;
  return Math.min(Math.max(parsed - 1, 0), LAST);
};

/** An answer replaces the shown draft unless it is an older version of the same one (a slow reload). */
const notOlder = (next: BffIncident, shown: BffIncident | null): boolean =>
  shown === null || shown.id !== next.id || next.version >= shown.version;

/**
 * Nuevo siniestro. Step one creates the draft (the server needs the vehicle and the type); from then on the
 * draft and the step live in the address, so a reload or a return later resumes where the person was. The
 * create request carries an Idempotency-Key kept until it succeeds, so a double click or a retry after a
 * network cut gives one folio, not two. Reporting is the server's decision: what is missing is listed.
 */
export function IncidentWizard() {
  const env = useIncidentEnv();
  const router = useRouter();
  const draftId = router.search.get('borrador');
  const step = clamp(router.search.get('paso'), draftId !== null);
  const loaded = useLive(
    () =>
      draftId === null
        ? Promise.resolve({
            ok: false as const,
            error: { status: 400 as const, code: 'bad_request', message: '', correlationId: '' },
          })
        : env.ports.get(draftId),
    [env.ports, draftId],
    env.onExpired,
    notOlder,
  );
  const keys = React.useRef(new SubmitKeys());
  const [notice, setNotice] = React.useState<string | null>(null);
  const [reportError, setReportError] = React.useState<string | null>(null);
  const [reporting, setReporting] = React.useState(false);
  // One source: the last known draft stays until the reload answers, so a child change never drops back
  // to an older version. Data of another draft (the address changed) is not shown.
  const draft = draftId === null || loaded.data?.id !== draftId ? null : loaded.data;
  const suggestions = useSuggestions(draft?.vehicle.id ?? null, draft?.occurredAt ?? null);
  const steps = useLive(
    () =>
      draft && step === LAST
        ? env.ports.nextSteps(draft.id)
        : Promise.resolve({
            ok: false as const,
            error: { status: 400 as const, code: 'bad_request', message: '', correlationId: '' },
          }),
    [env.ports, draft?.id, draft?.version, step],
    env.onExpired,
  );

  const goto = (next: number, id = draft?.id, replace = false) => {
    if (id) router.navigate(draftPath(id, next + 1), { replace });
  };
  const moved = (next: BffIncident, message?: string) => {
    loaded.set(next);
    setNotice(message ?? null);
  };

  if (draftId !== null && draft === null) {
    if (loaded.loading || (loaded.error === null && loaded.data?.id !== draftId))
      return <UiState kind="loading" />;
    return (
      <Box>
        <BackLink to={incidentsPath}>Siniestros</BackLink>
        {loaded.error?.status === 404 ? (
          <UiState
            kind="error"
            title="No encontramos este borrador"
            description="Puede que no exista o que no tengas acceso."
          />
        ) : (
          <UiState
            kind={loaded.error ? errorKind(loaded.error) : 'error'}
            actionLabel="Reintentar"
            onAction={loaded.reload}
          />
        )}
      </Box>
    );
  }
  if (draft !== null && draft.status !== 'draft')
    return (
      <Box>
        <BackLink to={incidentsPath}>Siniestros</BackLink>
        <UiState
          kind="closed"
          title="Este caso ya no es un borrador"
          description="Ábrelo desde el detalle del siniestro."
          actionLabel="Ver siniestro"
          onAction={() => router.navigate(incidentPath(draft.id))}
        />
      </Box>
    );

  const reload = () => {
    loaded.reload();
    steps.reload();
  };
  const create = async (fields: EventFields): Promise<SubmitOutcome> => {
    const { vehicleId, type, ...rest } = fields;
    if (!vehicleId || !type)
      return { ok: false, message: 'Elige el tipo de siniestro y el vehículo para empezar.' };
    const body = { vehicleId, type, ...rest };
    const result = await sendKeyed(keys.current, body, (key) => env.ports.create(body, key));
    return outcomeOf(
      result,
      env.onExpired,
      (created) => {
        loaded.set(created);
        setNotice('Borrador guardado.');
        router.navigate(draftPath(created.id, 2), { replace: true });
      },
      'crear el borrador',
    );
  };
  const save =
    (next: number) =>
    async (fields: EventFields): Promise<SubmitOutcome> => {
      if (!draft) return create(fields);
      if (Object.keys(fields).length === 0) {
        goto(next);
        return { ok: true };
      }
      return outcomeOf(
        await env.ports.update(draft.id, { version: draft.version, ...fields }),
        env.onExpired,
        (updated) => {
          moved(updated, 'Cambios guardados.');
          goto(next, updated.id);
        },
        'guardar los cambios',
      );
    };
  const back =
    step > 0 ? (
      <Button variant="text" onClick={() => goto(step - 1)}>
        Atrás
      </Button>
    ) : undefined;
  const child = {
    incident: draft as BffIncident,
    onVersion: (_version: number, message?: string) => {
      setNotice(message ?? null);
      loaded.reload();
    },
    onReload: reload,
  };
  const report = async () => {
    if (!draft || reporting) return;
    setReporting(true);
    setReportError(null);
    const body = { command: 'report' as const, version: draft.version };
    const result = await sendKeyed(keys.current, [draft.id, body], (key) =>
      env.ports.transition(draft.id, body, key),
    );
    setReporting(false);
    if (result.ok) return router.navigate(incidentPath(result.value.id));
    if (result.error.status === 401) env.onExpired();
    if (result.error.status === 422 && result.error.missingRequirements) steps.reload();
    setReportError(
      isStale(result.error)
        ? STALE_COPY
        : result.error.status === 422
          ? 'Faltan requisitos para reportar: revisa la lista.'
          : describeError(result.error, 'reportar el caso'),
    );
  };
  const reportView = stepViews(steps.data?.items ?? []).find((view) => view.command === 'report');
  const lines = reportView ? missingLines([reportView]) : [];

  return (
    <Box>
      <BackLink to={incidentsPath}>Siniestros</BackLink>
      <PageHeader
        title="Nuevo siniestro"
        description={
          draft ? `Borrador ${draft.folio}` : 'Captura el evento: se guarda como borrador.'
        }
        eyebrow="Siniestros"
      />
      <Wizard
        steps={[...WIZARD_STEPS]}
        activeStep={step}
        {...(draft ? { onStepChange: (next: number) => goto(next) } : {})}
      />
      <Box sx={{ mt: 3, display: 'grid', gap: 2 }}>
        {notice && <InlineAlert severity="success">{notice}</InlineAlert>}
        {step === 0 && (
          <Panel title="Datos del evento">
            <EventForm
              label="Datos del evento"
              incident={draft}
              groups={['event']}
              zone={env.zone}
              submitLabel={draft ? 'Guardar y continuar' : 'Crear'}
              allowEmpty
              onSubmit={save(1)}
              onReload={reload}
            />
          </Panel>
        )}
        {step === 1 && draft && (
          <Panel title="Conductor y póliza">
            <EventForm
              label="Conductor y póliza"
              incident={draft}
              groups={['driver', 'policy']}
              zone={env.zone}
              suggestions={suggestions}
              drivers={env.drivers}
              submitLabel="Guardar y continuar"
              allowEmpty
              actions={back}
              onSubmit={save(2)}
              onReload={reload}
            />
          </Panel>
        )}
        {step === 2 && draft && (
          <>
            <ThirdPartiesTab {...child} />
            <WizardNav back={back} next={() => goto(3)} />
          </>
        )}
        {step === 3 && draft && (
          <>
            <EvidenceTab {...child} />
            <Panel title="Si no hay foto">
              <EventForm
                label="Justificación sin foto"
                incident={draft}
                groups={['photo']}
                zone={env.zone}
                submitLabel="Guardar y continuar"
                allowEmpty
                actions={back}
                onSubmit={save(4)}
                onReload={reload}
              />
            </Panel>
          </>
        )}
        {step === LAST && draft && (
          <>
            <Panel title="Resumen del borrador">
              <DescriptionList
                items={[
                  { label: 'Tipo', value: TYPE_LABELS[draft.type] },
                  {
                    label: 'Vehículo',
                    value: `${draft.vehicle.economicNumber} · ${draft.vehicle.plate}`,
                  },
                  {
                    label: 'Fecha y hora del evento',
                    value: <DateTime value={draft.occurredAt} />,
                  },
                  { label: 'Ubicación', value: draft.location?.text ?? 'Sin ubicación' },
                  { label: 'Descripción', value: draft.description ?? 'Sin descripción' },
                  { label: 'Conductor', value: draft.driver?.displayName ?? 'Sin conductor' },
                ]}
              />
            </Panel>
            {steps.data === null && steps.loading ? (
              <UiState kind="loading" />
            ) : reportView === undefined ? (
              <Typography color="text.secondary">
                No tienes permiso para reportar este caso. El borrador queda guardado.
              </Typography>
            ) : (
              <NextStepPanel
                title={lines.length > 0 ? 'Falta para reportar' : 'Listo para reportar'}
                steps={lines.length > 0 ? lines : ['Revisa el resumen y reporta el caso.']}
              />
            )}
            {reportError && <InlineAlert severity="error">{reportError}</InlineAlert>}
            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
              {back}
              {reportView !== undefined && (
                <Button
                  variant="contained"
                  loading={reporting}
                  disabled={lines.length > 0}
                  onClick={() => void report()}
                >
                  Reportar
                </Button>
              )}
              <Button variant="outlined" onClick={() => router.navigate(incidentPath(draft.id))}>
                Guardar borrador y salir
              </Button>
            </Box>
          </>
        )}
      </Box>
    </Box>
  );
}

function WizardNav({ back, next }: { back: React.ReactNode; next: () => void }) {
  return (
    <Box sx={{ display: 'flex', gap: 1 }}>
      {back}
      <Button variant="contained" onClick={next}>
        Continuar
      </Button>
    </Box>
  );
}
