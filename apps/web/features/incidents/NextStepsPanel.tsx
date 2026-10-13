import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { Button, ConfirmWithReason, Field, InlineAlert, NextStepPanel } from '@opslog/ui';
import type {
  BffIncident,
  BffIncidentInsuranceInput,
  BffIncidentNextStep,
} from '@opslog/contracts';
import { useIncidentEnv } from './env';
import { describeError, isStale } from './errors';
import { COMMAND_LABELS } from './labels';
import {
  REASON_COMMANDS,
  approvalsToOffer,
  isFinished,
  missingLines,
  stepViews,
  type StepView,
} from './model';
import { SubmitKeys, sendKeyed } from './submit';
import type { IncidentCommand } from './types';
import type { Live } from './useLive';

/** Text a command asks for before it runs, and where the text is stored. */
const REASONS: Readonly<
  Partial<
    Record<
      IncidentCommand,
      { title: string; label: string; description: string; field?: keyof BffIncidentInsuranceInput }
    >
  >
> = {
  cancel: {
    title: 'Cancelar caso',
    label: 'Motivo de la cancelación',
    description: 'El caso quedará cancelado y dejará de admitir cambios.',
  },
  reopen: {
    title: 'Reabrir caso',
    label: 'Motivo de la reapertura',
    description: 'El caso vuelve a revisión y las aprobaciones se piden de nuevo.',
  },
  reject: {
    title: 'Registrar rechazo',
    label: 'Motivo del rechazo',
    description: 'Anota por qué la aseguradora rechazó el caso. También hace falta subir su carta.',
    field: 'rejectionReason',
  },
  no_insurance: {
    title: 'Continuar sin aseguradora',
    label: 'Por qué el caso sigue sin aseguradora',
    description: 'Queda registrado y la empresa seguirá el caso por su cuenta.',
    field: 'noInsuranceReason',
  },
  appeal: {
    title: 'Apelar',
    label: 'Nota de la apelación',
    description: 'El caso vuelve a estar con la aseguradora.',
    field: 'appealNote',
  },
};

const GUIDANCE: Readonly<Record<BffIncident['status'], string>> = {
  draft: 'Completa la captura y reporta el caso.',
  reported: 'Asigna a una persona responsable e inicia la revisión.',
  under_review: 'Registra los datos del seguro y elige cómo continúa el caso.',
  insurance_process: 'Registra el resultado de la aseguradora y continúa.',
  insurance_rejected: 'Apela el rechazo o continúa con el costo a cargo de la empresa.',
  no_insurance: 'Continúa con la reparación o resuelve el caso.',
  repair: 'Cuando la reparación termine, resuelve el caso.',
  resolved: 'Revisa la resolución y cierra el caso.',
  closed: 'Caso cerrado: es historial. Solo puede reabrirse con un motivo.',
  reopened: 'El caso se reabrió: vuelve a revisarlo.',
  cancelled: 'Caso cancelado: queda como historial.',
};

type Open = { readonly command: IncidentCommand } | null;

/**
 * Siguiente paso: the commands the server allows now, each with what it still lacks in plain Spanish. The
 * panel offers only what `next-steps` returned, so a caller with only `incidents:view` sees no buttons. When
 * the server needs a supervisor's approval (D20) it hides the command that would go ahead, explains why, and
 * offers "Aprobar" only to someone the server allowed to approve. It never compares amounts.
 */
export function NextStepsPanel({
  incident,
  steps,
  onIncident,
  onStale,
}: {
  incident: BffIncident;
  steps: Live<{ readonly items: readonly BffIncidentNextStep[] }>;
  onIncident: (incident: BffIncident, message: string) => void;
  onStale: () => void;
}) {
  const env = useIncidentEnv();
  const keys = React.useRef(new SubmitKeys());
  const [open, setOpen] = React.useState<Open>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [rejected, setRejected] = React.useState<{
    readonly command: IncidentCommand;
    readonly ids: readonly string[];
  } | null>(null);
  const [responsible, setResponsible] = React.useState('');
  // What the server just refused wins over a list loaded before the attempt, until the list is reloaded.
  React.useEffect(() => setRejected(null), [steps.data]);
  const base = stepViews(steps.data?.items ?? []);
  const views: readonly StepView[] = rejected
    ? base.map((view) =>
        view.command === rejected.command ? { ...view, missing: rejected.ids } : view,
      )
    : base;
  const offers = approvalsToOffer(incident, views);
  const finished = isFinished(incident);

  const execute = async (
    command: IncidentCommand,
    extra: { responsibleId?: string; reason?: string } = {},
    save?: () => Promise<
      { ok: true; value: BffIncident } | { ok: false; error: import('@opslog/contracts').ApiError }
    >,
  ) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    let version = incident.version;
    if (save) {
      const saved = await save();
      if (!saved.ok) {
        setBusy(false);
        if (saved.error.status === 401) env.onExpired();
        if (isStale(saved.error)) return onStale();
        return setError(describeError(saved.error));
      }
      version = saved.value.version;
    }
    const body = { command, version, ...extra };
    const result = await sendKeyed(keys.current, [incident.id, body], (key) =>
      env.ports.transition(incident.id, body, key),
    );
    setBusy(false);
    if (result.ok) {
      setOpen(null);
      setResponsible('');
      return onIncident(result.value, `${COMMAND_LABELS[command]}: listo.`);
    }
    const failure = result.error;
    if (failure.status === 401) env.onExpired();
    if (isStale(failure)) return onStale();
    if (failure.status === 422 && failure.missingRequirements) {
      setRejected({ command, ids: failure.missingRequirements });
      steps.reload();
      return setError('Faltan requisitos para continuar: revisa la lista.');
    }
    setError(describeError(failure));
  };

  const start = (command: IncidentCommand) => {
    setError(null);
    if (command === 'assign' || REASON_COMMANDS.includes(command)) setOpen({ command });
    else void execute(command);
  };
  const confirmReason = (command: IncidentCommand, reason: string) => {
    const config = REASONS[command];
    const field = config?.field;
    if (field)
      void execute(command, {}, () =>
        env.ports.updateInsurance(incident.id, {
          version: incident.version,
          [field]: reason,
        } as BffIncidentInsuranceInput),
      );
    else void execute(command, { reason });
  };

  const lines = missingLines(views);
  const guidance = finished
    ? [GUIDANCE[incident.status]]
    : views.length === 0
      ? ['Solo puedes consultar este caso: no tienes acciones disponibles.']
      : [GUIDANCE[incident.status]];
  const goes = views.filter(
    (view) => view.command !== 'approve_close' && view.command !== 'approve_assumption',
  );
  const reason = open && REASONS[open.command];
  return (
    <Box component="section" aria-label="Acciones del caso" sx={{ display: 'grid', gap: 2 }}>
      <NextStepPanel
        title={lines.length > 0 ? 'Falta para continuar' : 'Siguiente paso'}
        steps={lines.length > 0 ? lines : guidance}
      />
      {steps.error && !steps.data && (
        <InlineAlert
          severity="error"
          action={
            <Button color="inherit" onClick={steps.reload}>
              Reintentar
            </Button>
          }
        >
          No pudimos cargar los siguientes pasos.
        </InlineAlert>
      )}
      {views.some((view) => view.awaitsApproval) && (
        <Typography variant="body2" color="text.secondary">
          El costo a cargo de la empresa necesita la aprobación de una persona supervisora antes de
          continuar.
        </Typography>
      )}
      {error && <InlineAlert severity="error">{error}</InlineAlert>}
      {!finished || goes.length > 0 ? (
        <Box sx={{ display: 'grid', gap: 1 }}>
          {goes
            .filter((view) => !view.awaitsApproval)
            .map((view) => (
              <Button
                key={view.command}
                variant={view.command === 'cancel' ? 'outlined' : 'contained'}
                color={view.command === 'cancel' ? 'error' : 'primary'}
                disabled={busy}
                onClick={() => start(view.command)}
              >
                {view.label}
              </Button>
            ))}
          {offers.includes('close') && (
            <Button
              variant="contained"
              disabled={busy}
              onClick={() => void execute('approve_close')}
            >
              Aprobar cierre
            </Button>
          )}
          {offers.includes('assumption') && (
            <Button
              variant="contained"
              disabled={busy}
              onClick={() => void execute('approve_assumption')}
            >
              Aprobar asunción del costo
            </Button>
          )}
        </Box>
      ) : null}
      {open?.command === 'assign' && (
        <Box
          component="form"
          aria-label="Asignar responsable"
          onSubmit={(event: React.FormEvent) => {
            event.preventDefault();
            if (responsible) void execute('assign', { responsibleId: responsible });
          }}
          sx={{ display: 'grid', gap: 1.5 }}
        >
          <Field
            id="assign-responsible"
            label="Persona responsable"
            select
            required
            SelectProps={{ native: true }}
            InputLabelProps={{ shrink: true }}
            value={responsible}
            onChange={(event) => setResponsible(event.target.value)}
          >
            <option value="">Elige a una persona</option>
            {env.members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.label}
              </option>
            ))}
          </Field>
          <Box sx={{ display: 'flex', gap: 1 }}>
            <Button type="submit" variant="contained" loading={busy} disabled={!responsible}>
              Asignar
            </Button>
            <Button variant="text" disabled={busy} onClick={() => setOpen(null)}>
              Cancelar
            </Button>
          </Box>
        </Box>
      )}
      {open && reason && (
        <ConfirmWithReason
          key={open.command}
          title={reason.title}
          reasonLabel={reason.label}
          description={reason.description}
          confirmLabel={reason.title}
          busy={busy}
          onConfirm={(text) => confirmReason(open.command, text)}
          onCancel={() => setOpen(null)}
        />
      )}
    </Box>
  );
}
