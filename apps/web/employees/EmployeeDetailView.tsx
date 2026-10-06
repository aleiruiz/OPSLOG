import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import React from 'react';
import {
  Button,
  ConfirmDialog,
  Field,
  Notifications,
  opslogTokens,
  PageHeader,
  StatusBadge,
  Timeline,
  UiState,
} from '@opslog/ui';
import { ResourceView, type ResourceState } from '../app/resource';
import { RouterButton, RouterLink } from '../app/router';
import type {
  Area,
  Employee,
  EmployeeDetail,
  EmployeeHistoryEntry,
  EmployeeStatus,
} from '../app/types';
import { areaPath } from '../areas/AreaTreeView';
import { EmployeeNotFound, employeePath, employeesPath } from './EmployeeMessages';
import {
  canChangeStatus,
  describeHistory,
  fitnessPresentation,
  formatDate,
  formatDateTime,
  fullName,
  idTypeLabel,
  isArchivable,
  isEditable,
  kindLabels,
  statusOrder,
  statusPresentation,
} from './labels';
import type { EmployeeContext } from './loadEmployee';
import { MAX_REASON_LENGTH, STATUS_TRANSITIONS, isReasonValid } from './rules';

/** The confirmation dialogs the detail can open: archive, or terminate (a status change that cannot be undone). */
export interface EmployeeDialogState {
  readonly kind: 'archive' | 'terminate' | null;
  readonly busy: boolean;
  /** `terminate` only: the reason typed in the status panel, shown back for confirmation. */
  readonly reason?: string | undefined;
  readonly error?: string | undefined;
  readonly errorActionLabel?: string | undefined;
}

export const dialogClosed: EmployeeDialogState = { kind: null, busy: false };

/** The inline status-change panel. */
export interface StatusPanelState {
  readonly open: boolean;
  readonly busy: boolean;
  readonly error?: string | undefined;
  readonly errorActionLabel?: string | undefined;
}

export const statusPanelClosed: StatusPanelState = { open: false, busy: false };

export interface HistoryPage {
  readonly items: readonly EmployeeHistoryEntry[];
  readonly nextCursor: string | null;
  readonly total: number;
}

export interface HistoryProps {
  readonly state: ResourceState<HistoryPage>;
  readonly loadingMore?: boolean;
  readonly notice?: string | null;
  readonly onRetry: () => void;
  readonly onLoadMore: (cursor: string) => void;
}

export interface EmployeeDetailViewProps {
  readonly state: ResourceState<EmployeeContext>;
  readonly history: HistoryProps;
  readonly can: (permission: 'edit' | 'delete' | 'view_pii') => boolean;
  readonly notice?: string | null;
  readonly dialog: EmployeeDialogState;
  readonly statusPanel: StatusPanelState;
  /** Initial values of the status panel (stories and tests); the person types over them. */
  readonly statusDraft?: { readonly to: EmployeeStatus | ''; readonly reason: string };
  /** Start with the personal data shown (stories and tests). It always starts hidden for a person. */
  readonly piiRevealed?: boolean;
  readonly onRetry: () => void;
  readonly onStatusOpen: () => void;
  readonly onStatusCancel: () => void;
  readonly onStatusSubmit: (to: EmployeeStatus, reason: string) => void;
  readonly onStatusErrorAction: () => void;
  readonly onArchiveRequest: () => void;
  readonly onDialogConfirm: () => void;
  readonly onDialogCancel: () => void;
  readonly onDialogErrorAction: () => void;
}

const linkSx = { color: 'primary.main', textDecoration: 'underline' } as const;
const { colors } = opslogTokens;

function Mono({ children }: { children: React.ReactNode }) {
  return (
    <Typography component="span" sx={{ fontFamily: opslogTokens.typography.monoFamily }}>
      {children}
    </Typography>
  );
}

function BackLink() {
  return (
    <Box sx={{ mb: 2 }}>
      <RouterLink to={employeesPath} sx={linkSx}>
        Volver a empleados
      </RouterLink>
    </Box>
  );
}

/** Success message of the last change; kept focusable so the result is announced and reachable. */
function FocusNotice({ text }: { text: string }) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => ref.current?.focus(), [text]);
  return (
    <Box ref={ref} tabIndex={-1} sx={{ outline: 'none', mb: 2 }}>
      <Notifications messages={[{ id: 'notice', text, severity: 'success' }]} />
    </Box>
  );
}

function Rows({ rows }: { rows: readonly (readonly [string, React.ReactNode])[] }) {
  return (
    <Box
      component="dl"
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: '1fr', sm: 'minmax(160px, 220px) 1fr' },
        columnGap: 3,
        rowGap: { xs: 0.5, sm: 1.5 },
        m: 0,
        maxWidth: 720,
      }}
    >
      {rows.map(([label, value]) => (
        <React.Fragment key={label}>
          <Typography component="dt" variant="body2" color="text.secondary">
            {label}
          </Typography>
          <Typography
            component="dd"
            variant="body1"
            sx={{ m: 0, mb: { xs: 1.5, sm: 0 }, overflowWrap: 'anywhere' }}
          >
            {value}
          </Typography>
        </React.Fragment>
      ))}
    </Box>
  );
}

function Detail({ employee, areas }: { employee: Employee; areas: readonly Area[] }) {
  const status = statusPresentation[employee.status];
  const area = areas.find((item) => item.id === employee.areaId);
  const fitness = employee.fitness ? fitnessPresentation(employee.fitness) : null;
  const rows: [string, React.ReactNode][] = [
    ['Nombre', fullName(employee)],
    ['Tipo', kindLabels[employee.kind]],
    [
      'Número de empleado',
      employee.employeeNumber ? <Mono>{employee.employeeNumber}</Mono> : 'Sin número',
    ],
    ['Puesto', employee.position ?? 'Sin puesto'],
    ['Fecha de ingreso', employee.hireDate ? formatDate(employee.hireDate) : 'Sin fecha'],
    [
      'Área',
      <RouterLink to={areaPath(employee.areaId)} sx={linkSx}>
        {area ? area.name : employee.areaId}
      </RouterLink>,
    ],
    ['Estado', <StatusBadge label={status.label} tone={status.tone} />],
    ['Motivo del estado', employee.statusReason],
    ...(fitness && employee.fitness
      ? ([
          [
            'Aptitud para operar',
            <>
              <StatusBadge label={fitness.label} tone={fitness.tone} />
              {fitness.reasons.length > 0 && (
                <Box component="ul" sx={{ m: 0, mt: 0.5, pl: 2.5 }}>
                  {fitness.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </Box>
              )}
            </>,
          ],
          [
            'Tipo de licencia',
            employee.licenseType ? <Mono>{employee.licenseType}</Mono> : 'Sin tipo',
          ],
          [
            'Vigencia de la licencia',
            employee.licenseExpiresOn ? formatDate(employee.licenseExpiresOn) : 'Sin vigencia',
          ],
        ] as [string, React.ReactNode][])
      : []),
    ['Registrado', formatDateTime(employee.createdAt)],
    ['Última actualización', formatDateTime(employee.updatedAt)],
    ...(employee.archivedAt === null
      ? []
      : ([['Archivado', formatDateTime(employee.archivedAt)]] as [string, React.ReactNode][])),
  ];
  return <Rows rows={rows} />;
}

const MASK = '••••••••';

function Masked() {
  return (
    <>
      <span aria-hidden="true">{MASK}</span>
      <Box component="span" className="sr-only">
        Oculto
      </Box>
    </>
  );
}

const notOnFile = (
  <Typography component="span" color="text.secondary">
    No registrado
  </Typography>
);

/**
 * Personal data. A session without `view_pii` gets a masked placeholder (the server sends `pii: null`). A session
 * with it keeps the values hidden until the person asks to see them: the server already audited the disclosure
 * when it sent the data, and showing them is a deliberate action, not something that happens by opening the page.
 */
function PersonalData({
  employee,
  canView,
  initiallyRevealed,
}: {
  employee: EmployeeDetail;
  canView: boolean;
  initiallyRevealed: boolean;
}) {
  const [revealed, setRevealed] = React.useState(initiallyRevealed);
  const { piiPresent } = employee;
  const pii = canView ? employee.pii : null;
  const driver = employee.kind === 'driver';
  const entries: [string, boolean, React.ReactNode][] = pii
    ? [
        [
          'Identificación',
          pii.nationalId !== null,
          pii.nationalId !== null && (
            <Mono>
              {employee.idType ? `${idTypeLabel(employee.idType)} · ` : ''}
              {pii.nationalId}
            </Mono>
          ),
        ],
        ['Teléfono', pii.phone !== null, pii.phone && <Mono>{pii.phone}</Mono>],
        ['Correo electrónico', pii.email !== null, pii.email],
        ...(driver
          ? ([
              [
                'Número de licencia',
                pii.licenseNumber !== null,
                pii.licenseNumber && <Mono>{pii.licenseNumber}</Mono>,
              ],
            ] as [string, boolean, React.ReactNode][])
          : []),
      ]
    : [
        ['Identificación', piiPresent.nationalId, null],
        ['Teléfono', piiPresent.phone, null],
        ['Correo electrónico', piiPresent.email, null],
        ...(driver
          ? ([['Número de licencia', piiPresent.licenseNumber, null]] as [
              string,
              boolean,
              React.ReactNode,
            ][])
          : []),
      ];
  const rows = entries.map(([label, present, value]) => {
    let shown: React.ReactNode;
    if (!present) shown = notOnFile;
    else if (pii && revealed) shown = value;
    else shown = <Masked />;
    return [label, shown] as const;
  });
  return (
    <Box component="section" aria-labelledby="pii-title" sx={{ mt: 4 }}>
      <Typography id="pii-title" component="h2" variant="h2" sx={{ mb: 1 }}>
        Datos personales
      </Typography>
      {pii ? (
        <Typography color="text.secondary" sx={{ mb: 2 }}>
          {revealed
            ? 'Los datos personales están visibles. Ocúltalos cuando termines; el acceso a ellos queda registrado en la auditoría.'
            : 'Los datos personales están ocultos en pantalla hasta que decidas mostrarlos. El acceso a ellos queda registrado en la auditoría.'}
        </Typography>
      ) : (
        <Box sx={{ mb: 2 }}>
          <Notifications
            messages={[
              {
                id: 'pii-protected',
                severity: 'info',
                text: 'Datos personales protegidos: tu rol no incluye el permiso para verlos. Aquí solo ves cuáles están registrados.',
              },
            ]}
          />
        </Box>
      )}
      <Rows rows={rows} />
      {pii && (
        <Box sx={{ mt: 2 }}>
          <Button variant="outlined" onClick={() => setRevealed((value) => !value)}>
            {revealed ? 'Ocultar datos personales' : 'Mostrar datos personales'}
          </Button>
        </Box>
      )}
    </Box>
  );
}

interface PanelErrors {
  to?: string | undefined;
  reason?: string | undefined;
}

function StatusPanel({
  employee,
  state,
  draft,
  onCancel,
  onSubmit,
  onErrorAction,
}: {
  employee: Employee;
  state: StatusPanelState;
  draft: { to: EmployeeStatus | ''; reason: string };
  onCancel: () => void;
  onSubmit: (to: EmployeeStatus, reason: string) => void;
  onErrorAction: () => void;
}) {
  const uid = React.useId();
  const [to, setTo] = React.useState<EmployeeStatus | ''>(draft.to);
  const [reason, setReason] = React.useState(draft.reason);
  const [errors, setErrors] = React.useState<PanelErrors>({});
  const options = statusOrder.filter((status) =>
    STATUS_TRANSITIONS[employee.status].includes(status),
  );
  const alertRef = React.useRef<HTMLDivElement>(null);
  const firstRef = React.useRef<HTMLDivElement>(null);
  // The panel opens on its first field so the keyboard continues where the person asked for it.
  React.useEffect(() => firstRef.current?.querySelector('select')?.focus(), []);
  React.useEffect(() => {
    if (state.error) alertRef.current?.focus();
  }, [state.error]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (state.busy) return;
    const found: PanelErrors = {};
    if (to === '') found.to = 'Elige el nuevo estado.';
    if (!isReasonValid(reason))
      found.reason = `Escribe el motivo del cambio: una sola línea de hasta ${MAX_REASON_LENGTH} caracteres.`;
    setErrors(found);
    if (found.to) document.getElementById(`${uid}-to`)?.focus();
    else if (found.reason) document.getElementById(`${uid}-reason`)?.focus();
    else onSubmit(to as EmployeeStatus, reason.trim());
  };

  return (
    <Box
      component="form"
      noValidate
      onSubmit={submit}
      aria-label="Cambiar estado"
      sx={{ border: `1px solid ${colors.border}`, borderRadius: 1, p: 2, mb: 3, maxWidth: 720 }}
    >
      <Typography component="h2" variant="h2" sx={{ mb: 0.5 }}>
        Cambiar estado
      </Typography>
      <Typography color="text.secondary" sx={{ mb: 2 }}>
        El cambio queda en el historial con su motivo. La baja es definitiva.
      </Typography>
      {state.error && (
        <Box ref={alertRef} tabIndex={-1} sx={{ outline: 'none', mb: 2 }}>
          <Notifications
            messages={[{ id: 'status-error', text: state.error, severity: 'error' }]}
          />
          {state.errorActionLabel && (
            <Box sx={{ mt: 1 }}>
              <Button variant="outlined" onClick={onErrorAction}>
                {state.errorActionLabel}
              </Button>
            </Box>
          )}
        </Box>
      )}
      <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', md: '1fr 2fr' } }}>
        <Box ref={firstRef}>
          <Field
            id={`${uid}-to`}
            label="Nuevo estado"
            select
            SelectProps={{ native: true }}
            InputLabelProps={{ shrink: true }}
            value={to}
            onChange={(event) => {
              setTo(event.target.value as EmployeeStatus | '');
              setErrors((current) => ({ ...current, to: undefined }));
            }}
            required
            error={Boolean(errors.to)}
            {...(errors.to ? { helperText: errors.to } : {})}
            fullWidth
          >
            <option value="">Elige un estado</option>
            {options.map((status) => (
              <option key={status} value={status}>
                {statusPresentation[status].label}
              </option>
            ))}
          </Field>
        </Box>
        <Field
          id={`${uid}-reason`}
          label="Motivo"
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
            setErrors((current) => ({ ...current, reason: undefined }));
          }}
          required
          error={Boolean(errors.reason)}
          helperText={errors.reason ?? `Obligatorio, hasta ${MAX_REASON_LENGTH} caracteres.`}
          fullWidth
        />
      </Box>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 2 }}>
        <Button type="submit" variant="contained" loading={state.busy}>
          Cambiar estado
        </Button>
        <Button variant="text" onClick={onCancel} disabled={state.busy}>
          Cancelar
        </Button>
      </Box>
    </Box>
  );
}

function History({
  props,
  areaName,
}: {
  props: HistoryProps;
  areaName: (areaId: string) => string | null;
}) {
  const { state } = props;
  return (
    <Box component="section" aria-labelledby="history-title" sx={{ mt: 4 }}>
      <Typography id="history-title" component="h2" variant="h2" sx={{ mb: 1 }}>
        Historial
      </Typography>
      {state.status === 'ready' ? (
        <>
          <Timeline
            items={state.data.items.map((entry) => ({
              id: entry.id,
              title: describeHistory(entry, areaName),
              description: `${entry.reason ? `Motivo: ${entry.reason} · ` : ''}Por ${entry.actorId} · versión ${entry.version}`,
              date: formatDateTime(entry.at),
            }))}
          />
          {props.notice && (
            <Box sx={{ my: 1 }}>
              <Notifications
                messages={[{ id: 'history-notice', text: props.notice, severity: 'error' }]}
              />
            </Box>
          )}
          {state.data.nextCursor && (
            <Button
              variant="outlined"
              loading={props.loadingMore ?? false}
              onClick={() => props.onLoadMore(state.data.nextCursor as string)}
            >
              Cargar más historial
            </Button>
          )}
        </>
      ) : (
        <ResourceView state={state} onRetry={props.onRetry}>
          {() => null}
        </ResourceView>
      )}
    </Box>
  );
}

/** Employee detail: data, fitness, personal data (masked without `view_pii`), history and the permission-aware actions. */
export function EmployeeDetailView({
  state,
  history,
  can,
  notice = null,
  dialog,
  statusPanel,
  statusDraft = { to: '', reason: '' },
  piiRevealed = false,
  onRetry,
  onStatusOpen,
  onStatusCancel,
  onStatusSubmit,
  onStatusErrorAction,
  onArchiveRequest,
  onDialogConfirm,
  onDialogCancel,
  onDialogErrorAction,
}: EmployeeDetailViewProps) {
  if (state.status === 'error' && state.error.status === 404) return <EmployeeNotFound />;
  return (
    <>
      <BackLink />
      <ResourceView state={state} onRetry={onRetry}>
        {({ employee, areas }) => {
          const names = new Map(areas.map((item) => [item.id, item.name]));
          const changeable = can('edit') && canChangeStatus(employee);
          return (
            <>
              <PageHeader
                title={fullName(employee)}
                description={`${kindLabels[employee.kind]}${employee.position ? ` · ${employee.position}` : ''}`}
                actions={
                  <>
                    {can('edit') && isEditable(employee) && (
                      <RouterButton to={`${employeePath(employee.id)}/editar`} variant="contained">
                        Editar
                      </RouterButton>
                    )}
                    {changeable && !statusPanel.open && (
                      <Button variant="outlined" onClick={onStatusOpen}>
                        Cambiar estado
                      </Button>
                    )}
                    {can('delete') && isArchivable(employee) && (
                      <Button variant="outlined" color="error" onClick={onArchiveRequest}>
                        Archivar
                      </Button>
                    )}
                  </>
                }
              />
              {notice && <FocusNotice text={notice} />}
              {employee.archivedAt !== null ? (
                <Box sx={{ mb: 3 }}>
                  <UiState
                    kind="closed"
                    title="Empleado archivado"
                    description={`Se archivó el ${formatDateTime(employee.archivedAt)}. Es de solo lectura y no se puede restaurar desde la aplicación.`}
                  />
                </Box>
              ) : (
                employee.status === 'terminated' && (
                  <Box sx={{ mb: 3 }}>
                    <UiState
                      kind="closed"
                      title="Empleado dado de baja"
                      description="Es un registro histórico y no admite cambios."
                    />
                  </Box>
                )
              )}
              {changeable && statusPanel.open && (
                <StatusPanel
                  employee={employee}
                  state={statusPanel}
                  draft={statusDraft}
                  onCancel={onStatusCancel}
                  onSubmit={onStatusSubmit}
                  onErrorAction={onStatusErrorAction}
                />
              )}
              <Typography component="h2" variant="h2" sx={{ mb: 2 }}>
                Datos del empleado
              </Typography>
              <Detail employee={employee} areas={areas} />
              <PersonalData
                key={`${employee.id}:${employee.version}`}
                employee={employee}
                canView={can('view_pii')}
                initiallyRevealed={piiRevealed}
              />
              <History props={history} areaName={(id) => names.get(id) ?? null} />
              {dialog.kind === 'archive' && (
                <ConfirmDialog
                  title={`Archivar a ${fullName(employee)}`}
                  description="Dejará de aparecer en el listado y no se podrá editar. Esta acción no se puede deshacer desde la aplicación."
                  confirmLabel="Archivar empleado"
                  busy={dialog.busy}
                  {...(dialog.error ? { error: dialog.error } : {})}
                  {...(dialog.errorActionLabel
                    ? {
                        errorActionLabel: dialog.errorActionLabel,
                        onErrorAction: onDialogErrorAction,
                      }
                    : {})}
                  onConfirm={onDialogConfirm}
                  onCancel={onDialogCancel}
                />
              )}
              {dialog.kind === 'terminate' && (
                <ConfirmDialog
                  title={`Dar de baja a ${fullName(employee)}`}
                  description={`La baja es definitiva: el empleado quedará de solo lectura y no podrá volver a otro estado.${
                    dialog.reason ? ` Motivo: ${dialog.reason}` : ''
                  }`}
                  confirmLabel="Dar de baja"
                  busy={dialog.busy}
                  {...(dialog.error ? { error: dialog.error } : {})}
                  {...(dialog.errorActionLabel
                    ? {
                        errorActionLabel: dialog.errorActionLabel,
                        onErrorAction: onDialogErrorAction,
                      }
                    : {})}
                  onConfirm={onDialogConfirm}
                  onCancel={onDialogCancel}
                />
              )}
            </>
          );
        }}
      </ResourceView>
    </>
  );
}
