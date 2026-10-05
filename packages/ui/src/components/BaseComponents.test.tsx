import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Button,
  ConfirmWithReason,
  DataTable,
  DetailTabs,
  Field,
  FilterBar,
  FormSection,
  NextStepPanel,
  Notifications,
  PageHeader,
  SeverityBadge,
  Timeline,
  UploadQueue,
  Wizard,
} from './BaseComponents';

afterEach(cleanup);

describe('Button and Field', () => {
  it('disables and labels a loading button, and renders children otherwise', () => {
    const { rerender } = render(<Button loading>Guardar</Button>);
    const loading = screen.getByRole('button', { name: 'Cargando…' });
    expect(loading).toBeDisabled();
    expect(loading).toHaveAttribute('aria-busy', 'true');
    rerender(<Button>Guardar</Button>);
    expect(screen.getByRole('button', { name: 'Guardar' })).not.toHaveAttribute('aria-busy');
    rerender(<Button disabled>Guardar</Button>);
    expect(screen.getByRole('button', { name: 'Guardar' })).toBeDisabled();
  });

  it('links helper text to the input only when there is helper text', () => {
    const { rerender } = render(<Field label="Nombre" id="name" description="Obligatorio" />);
    expect(screen.getByLabelText('Nombre')).toHaveAttribute('aria-describedby', 'name-description');
    expect(screen.getByText('Obligatorio')).toHaveAttribute('id', 'name-description');
    rerender(
      <Field label="Nombre" id="name" helperText="Ayuda" error inputProps={{ lang: 'es' }} />,
    );
    expect(screen.getByLabelText('Nombre')).toHaveAttribute('lang', 'es');
    expect(screen.getByText('Ayuda')).toBeInTheDocument();
    rerender(<Field label="Sin ayuda" />);
    expect(screen.getByLabelText('Sin ayuda')).not.toHaveAttribute('aria-describedby');
  });
});

describe('layout and display components', () => {
  it('renders sections, headers, badges, timeline and next steps', () => {
    render(
      <>
        <FormSection title="Datos" description="Detalle">
          <span>hijo</span>
        </FormSection>
        <FormSection title="Sin descripción">
          <span>otro</span>
        </FormSection>
        <PageHeader title="Título" description="Descripción" actions={<button>Acción</button>} />
        <PageHeader title="Solo título" />
        <SeverityBadge severity="low" />
        <SeverityBadge severity="critical" />
        <Timeline
          items={[
            { id: '1', title: 'Creado', date: 'Hoy', description: 'Evento sintético' },
            { id: '2', title: 'Cerrado', date: 'Mañana' },
          ]}
        />
        <NextStepPanel steps={['Uno', 'Dos']} />
        <NextStepPanel title="Propio" steps={['Tres']} />
        <Notifications messages={[{ id: 'a', text: 'Hecho', severity: 'success' }]} />
      </>,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Título' })).toBeInTheDocument();
    expect(screen.getByText('Acción')).toBeInTheDocument();
    expect(screen.getByLabelText('Severidad: Baja')).toBeInTheDocument();
    expect(screen.getByLabelText('Severidad: Crítica')).toBeInTheDocument();
    expect(screen.getByText('Evento sintético')).toBeInTheDocument();
    expect(screen.getByLabelText('Siguiente paso')).toBeInTheDocument();
    expect(screen.getByLabelText('Propio')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Notificaciones' })).toHaveTextContent('Hecho');
  });
});

describe('interactive components', () => {
  it('toggles selection in DataTable and supports custom renderers', () => {
    const onSelectedChange = vi.fn();
    const rows = [
      { id: 'a', name: 'A', note: undefined as string | undefined },
      { id: 'b', name: 'B', note: 'x' },
    ];
    const { rerender } = render(
      <DataTable
        columns={[
          { key: 'name', label: 'Nombre', render: (value) => <b>{String(value)}!</b> },
          { key: 'note', label: 'Nota' },
        ]}
        rows={rows}
        selectable
        onSelectedChange={onSelectedChange}
      />,
    );
    expect(screen.getByText('A!')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Seleccionar a' }));
    expect(onSelectedChange).toHaveBeenLastCalledWith(['a']);
    rerender(
      <DataTable
        caption="Propia"
        columns={[{ key: 'name', label: 'Nombre' }]}
        rows={rows}
        selectable
        selected={['a']}
        onSelectedChange={onSelectedChange}
      />,
    );
    fireEvent.click(screen.getByRole('checkbox', { name: 'Seleccionar a' }));
    expect(onSelectedChange).toHaveBeenLastCalledWith([]);
    rerender(<DataTable columns={[{ key: 'name', label: 'Nombre' }]} rows={rows} selectable />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Seleccionar b' }));
    expect(screen.getByRole('checkbox', { name: 'Seleccionar b' })).not.toBeChecked();
    rerender(<DataTable columns={[{ key: 'name', label: 'Nombre' }]} rows={rows} />);
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('shows the clear action in FilterBar only when provided', () => {
    const onClear = vi.fn();
    const { rerender } = render(
      <FilterBar onClear={onClear}>
        <span>campo</span>
      </FilterBar>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Limpiar filtros' }));
    expect(onClear).toHaveBeenCalledTimes(1);
    rerender(
      <FilterBar>
        <span>campo</span>
      </FilterBar>,
    );
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders the active tab panel and notifies the parent on selection', () => {
    const onChange = vi.fn();
    render(
      <DetailTabs
        value="a"
        onChange={onChange}
        tabs={[
          { id: 'a', label: 'Uno', content: <p>Contenido uno</p> },
          { id: 'b', label: 'Dos' },
        ]}
      />,
    );
    expect(screen.getByText('Contenido uno')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Dos' }));
    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('reports wizard step clicks, tolerating a missing handler', () => {
    const onStepChange = vi.fn();
    const { rerender } = render(
      <Wizard steps={['Uno', 'Dos']} activeStep={1} onStepChange={onStepChange} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Uno/ }));
    expect(onStepChange).toHaveBeenCalledWith(0);
    rerender(<Wizard steps={['Uno', 'Dos']} activeStep={0} />);
    fireEvent.click(screen.getByRole('button', { name: /Dos/ }));
    expect(screen.getByRole('button', { name: /Dos/ })).toBeInTheDocument();
  });

  it('requires a reason before confirming and trims it', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const { rerender } = render(<ConfirmWithReason onConfirm={onConfirm} onCancel={onCancel} />);
    const confirm = screen.getByRole('button', { name: 'Confirmar' });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Motivo/), { target: { value: '   ' } });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Motivo/), { target: { value: '  porque  ' } });
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith('porque');
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    rerender(<ConfirmWithReason title="Otro" reasonLabel="Razón" onConfirm={onConfirm} />);
    expect(screen.queryByRole('button', { name: 'Cancelar' })).toBeNull();
    expect(screen.getByLabelText('Otro')).toBeInTheDocument();
  });

  it('renders every upload state and offers retry only for failed uploads with a handler', () => {
    const onRetry = vi.fn();
    const items = [
      { id: 'p', name: 'pendiente.pdf', progress: 0, status: 'pending' as const },
      { id: 'u', name: 'subiendo.pdf', progress: 40, status: 'uploading' as const },
      { id: 'c', name: 'listo.pdf', progress: 100, status: 'complete' as const },
      { id: 'e', name: 'fallo.pdf', progress: 0, status: 'error' as const },
    ];
    const { rerender } = render(<UploadQueue items={items} onRetry={onRetry} />);
    expect(screen.getByLabelText('Progreso de subiendo.pdf')).toBeInTheDocument();
    expect(screen.getByLabelText('Completado')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(onRetry).toHaveBeenCalledWith('e');
    rerender(<UploadQueue items={items} />);
    expect(screen.queryByRole('button', { name: 'Reintentar' })).toBeNull();
    expect(screen.getByText('No se pudo cargar el archivo.')).toBeInTheDocument();
  });
});
