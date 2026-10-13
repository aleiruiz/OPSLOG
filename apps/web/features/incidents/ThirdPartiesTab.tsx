import React from 'react';
import Box from '@mui/material/Box';
import { BFF_THIRD_PARTY_KINDS } from '@opslog/contracts';
import type {
  BffIncident,
  BffThirdParty,
  BffThirdPartyInput,
  BffThirdPartyPatch,
} from '@opslog/contracts';
import { Button, ConfirmDialog, InlineAlert, Panel, UiState } from '@opslog/ui';
import { useIncidentEnv } from './context';
import { RELOADED_COPY, describeError, isStale } from './errors';
import type { SubmitOutcome } from './EventForm';
import { KIND_LABELS } from './labels';
import { canWrite } from './model';
import { outcomeOf } from './outcome';
import { RecordForm, type FieldSpec } from './RecordForm';
import { SubmitKeys, sendKeyed } from './submit';
import { ThirdPartyCard } from './ThirdPartyCard';
import { useLive } from './useLive';
import { errorKind } from '../maintenance/useResult';

export interface ChildProps {
  readonly incident: BffIncident;
  /** A child changed: the case moved to this version; refresh what depends on it. */
  readonly onVersion: (version: number, message?: string) => void;
  readonly onReload: () => void;
}

const text = (value: string | undefined): string | null => (value?.trim() ? value.trim() : null);

function fieldsFor(restricted: boolean, creating: boolean): readonly FieldSpec[] {
  const identity = restricted
    ? 'Se guarda protegido: sin permiso para ver datos de identidad no lo volverás a ver.'
    : undefined;
  return [
    {
      key: 'kind',
      label: 'Tipo de tercero',
      kind: 'select',
      required: true,
      empty: 'Elige el tipo',
      options: BFF_THIRD_PARTY_KINDS.map((kind) => ({ value: kind, label: KIND_LABELS[kind] })),
    },
    { key: 'name', label: 'Nombre', kind: 'text', ...(identity ? { description: identity } : {}) },
    { key: 'contact', label: 'Contacto', kind: 'text' },
    { key: 'plates', label: 'Placas', kind: 'text' },
    { key: 'policyNumber', label: 'Número de póliza', kind: 'text' },
    { key: 'insurerName', label: 'Aseguradora', kind: 'text' },
    { key: 'damageDescription', label: 'Daños', kind: 'multiline' },
    {
      key: 'injuries',
      label: '¿Hubo lesiones?',
      kind: 'select',
      empty: creating ? 'No' : 'Sin cambio',
      options: [
        { value: 'yes', label: 'Sí' },
        { value: 'no', label: 'No' },
      ],
    },
  ];
}

function baseOf(party: BffThirdParty | null): Record<string, string> {
  return {
    kind: party?.kind ?? '',
    name: party?.name ?? '',
    contact: party?.contact ?? '',
    plates: party?.plates ?? '',
    policyNumber: party?.policyNumber ?? '',
    insurerName: party?.insurerName ?? '',
    damageDescription: party?.damageDescription ?? '',
    injuries: party === null ? '' : party.injuries ? 'yes' : 'no',
  };
}

/** Terceros: the people and property involved, with identity only when the server sends it. */
export function ThirdPartiesTab({ incident, onVersion, onReload }: ChildProps) {
  const env = useIncidentEnv();
  const list = useLive(
    () => env.ports.thirdParties.list(incident.id),
    [env.ports, incident.id, incident.version],
    env.onExpired,
  );
  const [form, setForm] = React.useState<'new' | BffThirdParty | null>(null);
  const [removing, setRemoving] = React.useState<BffThirdParty | null>(null);
  const [removeError, setRemoveError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const keys = React.useRef(new SubmitKeys());
  const writable = canWrite(incident);
  const restricted = list.data?.identityRestricted ?? true;

  if (list.data === null)
    return list.error ? (
      <UiState kind={errorKind(list.error)} actionLabel="Reintentar" onAction={list.reload} />
    ) : (
      <UiState kind="loading" />
    );

  const submit = async (changed: Readonly<Record<string, string>>): Promise<SubmitOutcome> => {
    const editing = form !== null && form !== 'new' ? form : null;
    const body: Record<string, unknown> = { version: incident.version };
    if (changed['kind'] !== undefined) body['kind'] = changed['kind'];
    for (const key of [
      'name',
      'contact',
      'plates',
      'policyNumber',
      'insurerName',
      'damageDescription',
    ] as const)
      if (changed[key] !== undefined) body[key] = text(changed[key]);
    if (changed['injuries'] !== undefined) body['injuries'] = changed['injuries'] === 'yes';
    if (editing === null) {
      if (!body['kind']) return { ok: false, message: 'Elige el tipo de tercero.' };
      const result = await sendKeyed(keys.current, [incident.id, body], (key) =>
        env.ports.thirdParties.create(incident.id, body as unknown as BffThirdPartyInput, key),
      );
      return outcomeOf(
        result,
        env.onExpired,
        (change) => {
          setForm(null);
          onVersion(change.version, 'Tercero agregado.');
        },
        'agregar al tercero',
      );
    }
    return outcomeOf(
      await env.ports.thirdParties.update(
        incident.id,
        editing.id,
        body as unknown as BffThirdPartyPatch,
      ),
      env.onExpired,
      (change) => {
        setForm(null);
        onVersion(change.version, 'Tercero actualizado.');
      },
      'guardar al tercero',
    );
  };
  const remove = async (party: BffThirdParty) => {
    setBusy(true);
    setRemoveError(null);
    const result = await env.ports.thirdParties.remove(incident.id, party.id, incident.version);
    setBusy(false);
    if (result.ok) {
      setRemoving(null);
      onVersion(result.value.version, 'Tercero retirado.');
    } else {
      if (result.error.status === 401) env.onExpired();
      if (isStale(result.error)) onReload();
      setRemoveError(
        isStale(result.error) ? RELOADED_COPY : describeError(result.error, 'retirar al tercero'),
      );
    }
  };
  const editing = form !== null && form !== 'new' ? form : null;
  return (
    <>
      <Panel
        title="Terceros involucrados"
        {...(restricted && list.data.items.length > 0
          ? {
              description:
                'Datos de identidad restringidos: se muestran solo a quien tiene permiso.',
            }
          : {})}
        actions={
          writable && form === null ? (
            <Button variant="contained" onClick={() => setForm('new')}>
              Agregar tercero
            </Button>
          ) : undefined
        }
      >
        {list.error && (
          <InlineAlert severity="error">No pudimos actualizar la lista de terceros.</InlineAlert>
        )}
        {form !== null && (
          <RecordForm
            key={editing?.id ?? 'new'}
            label={editing ? 'Editar tercero' : 'Agregar tercero'}
            fields={fieldsFor(restricted, editing === null)}
            base={baseOf(editing)}
            submitLabel={editing ? 'Guardar tercero' : 'Guardar nuevo tercero'}
            onSubmit={submit}
            onReload={onReload}
            actions={
              <Button variant="text" onClick={() => setForm(null)}>
                Cancelar
              </Button>
            }
          />
        )}
        {list.data.items.length === 0 ? (
          <UiState
            kind="empty"
            title="Sin terceros registrados"
            description={
              writable
                ? 'Agrega a las personas, vehículos o propiedades involucradas.'
                : 'Cuando se registren terceros aparecerán aquí.'
            }
          />
        ) : (
          <Box component="ul" aria-label="Terceros" sx={{ display: 'grid', gap: 2, p: 0, m: 0 }}>
            {list.data.items.map((party, index) => (
              <ThirdPartyCard
                key={party.id}
                party={party}
                position={index + 1}
                writable={writable}
                onEdit={() => setForm(party)}
                onRemove={() => {
                  setRemoveError(null);
                  setRemoving(party);
                }}
              />
            ))}
          </Box>
        )}
      </Panel>
      {removing && (
        <ConfirmDialog
          title="Retirar tercero"
          description="El tercero deja de aparecer en el caso. Queda constancia en el historial."
          confirmLabel="Retirar"
          busy={busy}
          {...(removeError ? { error: removeError } : {})}
          onConfirm={() => void remove(removing)}
          onCancel={() => setRemoving(null)}
        />
      )}
    </>
  );
}
