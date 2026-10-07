import { describe, expect, it } from 'vitest';
import { createMockApi } from '../app/mockApi';
import { click, deferred, fireEvent, renderApp, screen, waitFor } from '../app/test/utils';
import { describeFailure } from './ImportFormScreen';

const header = 'economicNumber,plate,make,model,year,areaId,odometerKm';
const good = (n: number) => `ECO-N${n},NEW-${n}00,Nissan,NP300,2022,area-norte,100`;
const file = (...rows: string[]) => [header, ...rows].join('\n');
const exact = (label: string) => screen.getByLabelText(label);
const set = (label: string, value: string) => fireEvent.change(exact(label), { target: { value } });
const open = (options: Parameters<typeof renderApp>[0] = {}) =>
  renderApp({ path: '/flota/importaciones/nueva', ...options });
const fill = async (csv: string, options: Parameters<typeof renderApp>[0] = {}) => {
  const view = await open(options);
  await screen.findByRole('form', { name: 'Nueva importación' });
  set('Contenido CSV *', csv);
  return view;
};
const validate = async () => {
  click('Validar archivo');
  await screen.findByRole('heading', { name: 'Resultado de la validación' });
};

describe('new import form', () => {
  it('explains the template and privacy, and offers validation before any commit action', async () => {
    await open();
    await screen.findByRole('form', { name: 'Nueva importación' });
    expect(screen.getByText(/nunca el contenido de las celdas/)).toBeInTheDocument();
    expect(screen.getByText(/Hasta 500 filas por archivo/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Descargar plantilla' })).toHaveAttribute(
      'download',
      'plantilla-vehiculos.csv',
    );
    expect(screen.queryByText(/contienen datos personales/)).toBeNull();
    expect(screen.queryByLabelText('Qué hacer con el archivo *')).toBeNull();
    expect(screen.getByRole('button', { name: 'Validar archivo' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Importar/ })).toBeNull();
  });

  it('does not offer a commit while the server validation is still running', async () => {
    const api = createMockApi();
    const submit = api.imports.submit;
    api.imports.submit = async (input) => {
      const result = await submit(input);
      if (!result.ok || input.mode !== 'dry_run') return result;
      return {
        ...result,
        value: {
          ...result.value,
          job: { ...result.value.job, status: 'running', finishedAt: null },
        },
      };
    };
    await fill(file(good(1)), { api });
    await validate();
    expect(screen.getByText(/validación sigue en curso/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Importar/ })).toBeNull();
  });

  it('shows what it detected, and the error of a bad file on submit', async () => {
    await fill(file(good(1), good(2)));
    expect(screen.getByText('Detectamos 2 filas y 7 columnas.')).toBeInTheDocument();
    set('Contenido CSV *', 'a,"b');
    click('Validar archivo');
    expect(await screen.findByText(/revisa las comillas/)).toBeInTheDocument();
    expect(exact('Contenido CSV *')).toHaveFocus();
  });

  it('reads a CSV file chosen from disk', async () => {
    await open();
    await screen.findByRole('form', { name: 'Nueva importación' });
    const input = exact('Cargar archivo CSV') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File([file(good(1))], 'vehiculos.csv', { type: 'text/csv' })] },
    });
    await screen.findByText('Archivo cargado: vehiculos.csv');
    expect((exact('Contenido CSV *') as HTMLTextAreaElement).value).toContain('ECO-N1');
    fireEvent.change(exact('Contenido CSV *'), { target: { value: 'x' } });
    expect(screen.queryByText(/Archivo cargado/)).toBeNull();
    fireEvent.change(input, {
      target: { files: [new File(['x'.repeat(1_100_000)], 'enorme.csv', { type: 'text/csv' })] },
    });
    expect(await screen.findByText(/demasiado grande/)).toBeInTheDocument();
  });

  it('validates without creating anything, then imports with a key and the validation id', async () => {
    const { api } = await fill(file(good(1), good(2), 'ECO-X,,Nissan,NP300,2022,area-norte,100'));
    const before = (await api.vehicles.list({ limit: 100 })).ok ? 1 : 0;
    expect(before).toBe(1);
    await validate();
    expect(api.controls.imports()[0]).toMatchObject({
      mode: 'dry_run',
      validRows: 2,
      invalidRows: 1,
    });
    expect(screen.getByText(/1 filas tienen errores y no se importarán/)).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: 'Filas con error (1)' });
    expect(table).toHaveTextContent('Falta un valor obligatorio');
    expect(table).toHaveTextContent('Placa');
    expect(table).not.toHaveTextContent('ECO-X');
    expect(screen.getByRole('button', { name: 'Importar todo' })).toBeDisabled();
    click('Importar las 2 filas válidas');
    await screen.findByRole('heading', { name: 'Importación de vehículos', level: 1 });
    expect(
      screen.getByText('Importación terminada. Revisa el informe por fila.'),
    ).toBeInTheDocument();
    expect(window.location.search).toBe('');
    expect(api.controls.imports()[0]).toMatchObject({ mode: 'commit_valid', importedRows: 2 });
  });

  it('imports everything when the validation found no errors', async () => {
    const { api } = await fill(file(good(1)));
    await validate();
    expect(screen.getByText(/Todas las filas son válidas/)).toBeInTheDocument();
    click('Importar todo');
    await screen.findByRole('heading', { name: 'Importación de vehículos', level: 1 });
    expect(api.controls.imports()[0]).toMatchObject({ mode: 'commit_all', importedRows: 1 });
  });

  it('asks to validate again when the file changes after validating', async () => {
    await fill(file(good(1)));
    await validate();
    set('Contenido CSV *', file(good(1), good(2)));
    expect(screen.getByText(/Cambiaste el archivo después de validarlo/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Importar todo' })).toBeNull();
    // Restoring the exact file restores the same validation preview.
    set('Contenido CSV *', file(good(1)));
    expect(screen.getByRole('heading', { name: 'Resultado de la validación' })).toBeInTheDocument();
  });

  it('reuses the key of a retry and replays a request already processed', async () => {
    const api = createMockApi();
    await fill(file(good(1)), { api });
    await validate();
    api.controls.failNext('submitImport');
    click('Importar las 1 filas válidas');
    expect(await screen.findByText('No pudimos importar el archivo')).toBeInTheDocument();
    expect(screen.getByText(/no se creará nada dos veces/)).toBeInTheDocument();
    const commits = () =>
      api.controls.imports().filter((job) => job.mode === 'commit_valid').length;
    const before = commits();
    click('Importar las 1 filas válidas');
    await screen.findByRole('heading', { name: 'Importación de vehículos', level: 1 });
    expect(commits()).toBe(before + 1);
  });

  it('keeps all-or-nothing disabled when the preview contains errors', async () => {
    const { api } = await fill(file(good(1), 'ECO-X,,Nissan,NP300,2022,area-norte,100'));
    const before = api.controls.imports().length;
    await validate();
    expect(screen.getByRole('button', { name: 'Importar todo' })).toBeDisabled();
    expect(api.controls.imports()).toHaveLength(before + 1);
    expect(api.controls.imports()[0]).toMatchObject({ mode: 'dry_run', status: 'validated' });
  });

  it('keeps the form while sending and blocks a second submit', async () => {
    const api = createMockApi();
    const real = api.imports.submit;
    const gate = deferred();
    let calls = 0;
    api.imports.submit = async (input) => {
      calls += 1;
      await gate.promise;
      return real(input);
    };
    await fill(file(good(1)), { api });
    click('Validar archivo');
    await waitFor(() => expect(calls).toBe(1));
    fireEvent.submit(screen.getByRole('form', { name: 'Nueva importación' }));
    expect(calls).toBe(1);
    gate.resolve();
    await screen.findByRole('heading', { name: 'Resultado de la validación' });
  });

  it('retries the error report when it cannot be loaded', async () => {
    const api = createMockApi();
    await fill(file(good(1), 'ECO-X,,Nissan,NP300,2022,area-norte,100'), { api });
    api.controls.failNext('importRows');
    await validate();
    click('Reintentar');
    expect(await screen.findByRole('table', { name: 'Filas con error (1)' })).toBeInTheDocument();
  });

  it('links to the full report when there are more errors than shown', async () => {
    const bad = Array.from({ length: 30 }, (_, i) => `ECO-B${i},,Nissan,NP300,2022,area-norte,1`);
    await fill(file(...bad));
    await validate();
    await screen.findByRole('table', { name: 'Filas con error (30)' });
    expect(screen.getByText(/Se muestran las primeras 25 filas/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ver el informe completo' })).toHaveAttribute(
      'href',
      expect.stringMatching(/^\/flota\/importaciones\/imp-/),
    );
    expect(screen.getByRole('button', { name: 'Importar las 0 filas válidas' })).toBeDisabled();
  });
});

describe('personal data in employee files', () => {
  const employees =
    'kind,firstName,lastName,areaId,email\ndriver,Ana,Lopez,area-norte,a@ejemplo.test';

  it('warns a role without view_pii and blocks the columns before sending', async () => {
    const api = createMockApi();
    await fill(employees, { api, account: 'dispatch' });
    set('Registros a importar *', 'employee');
    expect(screen.getByText(/Tu rol no puede importarlas/)).toBeInTheDocument();
    const before = api.controls.imports().length;
    click('Validar archivo');
    expect(await screen.findByText(/incluye columnas con datos personales/)).toBeInTheDocument();
    expect(api.controls.imports()).toHaveLength(before);
  });

  it('lets a role with view_pii validate and import them without echoing values', async () => {
    const { api } = await fill(employees, { account: 'piiReader' });
    set('Registros a importar *', 'employee');
    expect(screen.getByText(/Tu rol puede importarlas/)).toBeInTheDocument();
    await validate();
    expect(screen.getByText(/Todas las filas son válidas/)).toBeInTheDocument();
    expect(screen.queryByText('a@ejemplo.test')).toBeNull();
    click('Importar todo');
    await screen.findByRole('heading', { name: 'Importación de empleados', level: 1 });
    expect(api.controls.imports()[0]).toMatchObject({ entity: 'employee', importedRows: 1 });
  });
});

describe('access', () => {
  it('does not offer a new import to a read-only role', async () => {
    await open({ account: 'viewer' });
    expect(
      await screen.findByRole('heading', { name: /Sin permiso|Acceso denegado|No tienes/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Nueva importación' })).toBeNull();
  });

  it('cancels back to the history', async () => {
    await open();
    await screen.findByRole('form', { name: 'Nueva importación' });
    fireEvent.click(screen.getByRole('link', { name: 'Cancelar' }));
    await screen.findByRole('heading', { name: 'Importaciones', level: 1 });
    expect(window.location.pathname).toBe('/flota/importaciones');
  });
});

describe('describeFailure', () => {
  const error = (status: number, code: string) =>
    ({ status, code, message: 'x', requestId: 'r' }) as never;
  it('maps every failure to a message and an action, and 401 to nothing', () => {
    expect(describeFailure(error(401, 'unauthorized'), 'dry_run').alert).toBeNull();
    expect(describeFailure(error(409, 'conflict'), 'commit_all').alert?.actionLabel).toBe(
      'Ver el historial de importaciones',
    );
    expect(describeFailure(error(400, 'validation_failed'), 'dry_run').alert?.title).toMatch(
      /rechazó/,
    );
    expect(describeFailure(error(403, 'forbidden'), 'commit_all').alert?.title).toBe(
      'No tienes permiso',
    );
    expect(describeFailure(error(404, 'not_found'), 'commit_valid').alert?.title).toMatch(
      /validación/,
    );
    expect(describeFailure(error(500, 'internal'), 'dry_run').alert?.title).toBe(
      'No pudimos validar el archivo',
    );
    expect(describeFailure(error(500, 'internal'), 'commit_all').alert?.message).toMatch(
      /misma clave/,
    );
  });
});
