import React from 'react';
import { PageHeader } from '@opslog/ui';
import type { ResourceState } from '../app/resource';
import { useRouter } from '../app/router';
import type { ApiError, ImportMode, ImportRow } from '../app/types';
import { useSession } from '../auth/session';
import { ImportForm, type FormAlert, type ValidationResult } from './ImportForm';
import { importPath, importsPath } from './ImportMessages';
import {
  fileSignatureOf,
  signatureOf,
  toInput,
  type ImportFormValues,
} from './formModel';
import { newIdempotencyKey } from './idempotency';

interface Failure {
  readonly alert: FormAlert | null;
}

const none: Failure = { alert: null };
const REPORT_ROWS = 25;
const HISTORY = 'Ver el historial de importaciones';

/** Maps a failed import to what the person sees: an alert, or (401) nothing at all. */
export function describeFailure(error: ApiError, mode: ImportMode): Failure {
  const verb = mode === 'dry_run' ? 'validar' : 'importar';
  const fail = (title: string, message: string, actionLabel?: string): FormAlert => ({
    severity: 'error',
    title,
    message,
    ...(actionLabel ? { actionLabel } : {}),
  });
  if (error.status === 401) return none;
  if (error.code === 'conflict')
    return {
      alert: fail(
        'No pudimos importar con esta solicitud',
        'La solicitud choca con otra anterior: el archivo cambió respecto a la validación, se usó la misma clave con otro contenido, o hay una importación en curso. No se creó nada nuevo. Revisa el historial antes de reintentar.',
        HISTORY,
      ),
    };
  if (error.status === 400)
    return {
      alert: fail(
        'El servidor rechazó el archivo',
        'Revisa que las columnas sean las de la plantilla, que las comillas estén balanceadas y que no pase de 500 filas. No se creó ningún registro.',
      ),
    };
  if (error.status === 403)
    return {
      alert: fail(
        'No tienes permiso',
        'Importar requiere permiso para crear. Los archivos de empleados con datos personales también requieren permiso para ver datos personales.',
      ),
    };
  if (error.status === 404)
    return {
      alert: fail(
        'No encontramos la validación',
        'Valida el archivo de nuevo antes de importar. No se creó ningún registro.',
      ),
    };
  return {
    alert: fail(
      `No pudimos ${verb} el archivo`,
      mode === 'dry_run'
        ? 'Intenta nuevamente.'
        : 'Intenta nuevamente: la importación usa la misma clave, así que no se creará nada dos veces.',
    ),
  };
}

/** New import: validate a CSV, read the per-row report and confirm it. Requires `create` (and `view_pii` for personal-data columns). */
export function ImportCreateScreen() {
  const { ports, can, markExpired } = useSession();
  const router = useRouter();
  const [submitting, setSubmitting] = React.useState<ImportMode | null>(null);
  const [failure, setFailure] = React.useState<Failure>(none);
  const [validation, setValidation] = React.useState<ValidationResult | null>(null);
  const canViewPii = can('view_pii');
  // One idempotency key per request: a retry of the same request reuses it, another request gets a new one.
  const attempt = React.useRef<{ signature: string; key: string } | null>(null);
  const keyFor = (signature: string): string => {
    if (attempt.current?.signature !== signature)
      attempt.current = { signature, key: newIdempotencyKey() };
    return attempt.current.key;
  };

  const loadRows = async (jobId: string, fileSignature: string) => {
    const result = await ports.imports.rows(jobId, { outcome: 'invalid', limit: REPORT_ROWS });
    const rows: ResourceState<{ items: readonly ImportRow[]; total: number }> = result.ok
      ? { status: 'ready', data: { items: result.value.items, total: result.value.total } }
      : result.error.status === 401
        ? { status: 'expired' }
        : { status: 'error', error: result.error };
    if (!result.ok && result.error.status === 401) markExpired();
    setValidation((current) =>
      current && current.job.id === jobId && current.fileSignature === fileSignature
        ? { ...current, rows }
        : current,
    );
  };

  const run = async (values: ImportFormValues, dryRunJobId?: string) => {
    setSubmitting(values.mode);
    setFailure(none);
    const key = values.mode === 'dry_run' ? undefined : keyFor(signatureOf(values, dryRunJobId));
    const result = await ports.imports.submit(
      toInput(values, {
        ...(key === undefined ? {} : { idempotencyKey: key }),
        ...(dryRunJobId === undefined ? {} : { dryRunJobId }),
      }),
    );
    setSubmitting(null);
    if (!result.ok) {
      if (result.error.status === 401) markExpired();
      setFailure(describeFailure(result.error, values.mode));
      return;
    }
    const { job, replayed } = result.value;
    if (values.mode === 'dry_run') {
      const fileSignature = fileSignatureOf(values);
      setValidation({ job, fileSignature, rows: { status: 'loading' } });
      if (job.invalidRows > 0) void loadRows(job.id, fileSignature);
      else
        setValidation({
          job,
          fileSignature,
          rows: { status: 'ready', data: { items: [], total: 0 } },
        });
      return;
    }
    attempt.current = null;
    const aviso = replayed ? 'repetida' : job.status === 'failed' ? 'fallida' : 'importada';
    router.navigate(`${importPath(job.id)}?aviso=${aviso}`);
  };

  return (
    <>
      <PageHeader
        title="Nueva importación"
        description="Importa vehículos o empleados desde un archivo CSV. Valida primero: la validación no crea nada y te dice qué filas tienen errores."
      />
      <ImportForm
        canViewPii={canViewPii}
        submitting={submitting !== null}
        submittingMode={submitting}
        validation={validation}
        alert={failure.alert}
        onAlertAction={() => router.navigate(importsPath)}
        onRetryRows={() => {
          if (validation) {
            setValidation({ ...validation, rows: { status: 'loading' } });
            void loadRows(validation.job.id, validation.fileSignature);
          }
        }}
        cancelTo={importsPath}
        onSubmit={(values) => void run(values)}
        onConfirm={(values, mode) =>
          void run({ ...values, mode }, validation?.job.id)
        }
      />
    </>
  );
}
