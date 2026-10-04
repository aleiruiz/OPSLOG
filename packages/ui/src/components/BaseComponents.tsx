import React from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import Step from '@mui/material/Step';
import StepButton from '@mui/material/StepButton';
import Stepper from '@mui/material/Stepper';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

export type ButtonProps = React.ComponentProps<typeof Button> & { loading?: boolean };
export function ButtonControl({ loading = false, disabled, children, ...props }: ButtonProps) {
  return (
    <Button {...props} disabled={disabled || loading} aria-busy={loading || undefined}>
      {loading ? 'Cargando…' : children}
    </Button>
  );
}
export { ButtonControl as Button };

export type FieldProps = React.ComponentProps<typeof TextField> & { description?: string };
export function Field({ id, label, description, helperText, error, ...props }: FieldProps) {
  const helperId = `${id ?? 'field'}-description`;
  return (
    <TextField
      {...props}
      id={id}
      label={label}
      error={error}
      helperText={helperText ?? description}
      FormHelperTextProps={{ id: helperId }}
      inputProps={{ 'aria-describedby': helperId, ...props.inputProps }}
    />
  );
}
export function FormSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <Box component="fieldset" sx={{ border: 0, p: 0, m: 0 }}>
      <Typography component="legend" variant="h6">
        {title}
      </Typography>
      {description && (
        <Typography color="text.secondary" variant="body2" sx={{ mb: 2 }}>
          {description}
        </Typography>
      )}
      <Stack spacing={2}>{children}</Stack>
    </Box>
  );
}
export function SeverityBadge({ severity }: { severity: 'low' | 'medium' | 'high' | 'critical' }) {
  const labels = { low: 'Baja', medium: 'Media', high: 'Alta', critical: 'Crítica' };
  const colors = { low: 'success', medium: 'info', high: 'warning', critical: 'error' } as const;
  return (
    <Chip
      size="small"
      label={labels[severity]}
      color={colors[severity]}
      aria-label={`Severidad: ${labels[severity]}`}
    />
  );
}
export type DataTableColumn<T> = {
  key: keyof T & string;
  label: string;
  render?: (value: T[keyof T], row: T) => React.ReactNode;
};
export function DataTable<T extends { id: string }>({
  columns,
  rows,
  caption = 'Registros',
  selectable = false,
  selected = [],
  onSelectedChange,
}: {
  columns: DataTableColumn<T>[];
  rows: T[];
  caption?: string;
  selectable?: boolean;
  selected?: string[];
  onSelectedChange?: (ids: string[]) => void;
}) {
  const toggle = (id: string) =>
    onSelectedChange?.(
      selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id],
    );
  return (
    <Table aria-label={caption} size="small">
      <caption style={{ textAlign: 'left', padding: 8 }}>{caption}</caption>
      <TableHead>
        <TableRow>
          {selectable && (
            <TableCell padding="checkbox">
              <span className="sr-only">Seleccionar</span>
            </TableCell>
          )}
          {columns.map((column) => (
            <TableCell key={column.key}>{column.label}</TableCell>
          ))}
        </TableRow>
      </TableHead>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id} hover>
            {selectable && (
              <TableCell padding="checkbox">
                <Checkbox
                  checked={selected.includes(row.id)}
                  onChange={() => toggle(row.id)}
                  inputProps={{ 'aria-label': `Seleccionar ${row.id}` }}
                />
              </TableCell>
            )}
            {columns.map((column) => (
              <TableCell key={column.key}>
                {column.render
                  ? column.render(row[column.key], row)
                  : String(row[column.key] ?? '')}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
export function FilterBar({
  children,
  onClear,
}: {
  children: React.ReactNode;
  onClear?: () => void;
}) {
  return (
    <Stack
      component="form"
      direction={{ xs: 'column', sm: 'row' }}
      spacing={2}
      alignItems={{ sm: 'center' }}
      role="search"
      aria-label="Filtros"
    >
      {children}
      {onClear && (
        <ButtonControl variant="text" onClick={onClear}>
          Limpiar filtros
        </ButtonControl>
      )}
    </Stack>
  );
}
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <Stack
      component="header"
      direction={{ xs: 'column', sm: 'row' }}
      justifyContent="space-between"
      gap={2}
      sx={{ mb: 3 }}
    >
      <Box>
        <Typography component="h1" variant="h4">
          {title}
        </Typography>
        {description && <Typography color="text.secondary">{description}</Typography>}
      </Box>
      {actions && (
        <Stack direction="row" gap={1}>
          {actions}
        </Stack>
      )}
    </Stack>
  );
}
export function DetailTabs({
  tabs,
  value,
  onChange,
}: {
  tabs: { id: string; label: string; content?: React.ReactNode }[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Box>
      <Tabs
        value={value}
        onChange={(_, next) => onChange(next)}
        aria-label="Secciones del detalle"
        variant="scrollable"
        scrollButtons="auto"
      >
        {tabs.map((tab) => (
          <Tab
            key={tab.id}
            value={tab.id}
            label={tab.label}
            id={`tab-${tab.id}`}
            aria-controls={`tabpanel-${tab.id}`}
          />
        ))}
      </Tabs>
      {tabs.map((tab) => (
        <Box
          key={tab.id}
          role="tabpanel"
          hidden={value !== tab.id}
          id={`tabpanel-${tab.id}`}
          aria-labelledby={`tab-${tab.id}`}
          tabIndex={0}
          sx={{ pt: 2 }}
        >
          {value === tab.id && tab.content}
        </Box>
      ))}
    </Box>
  );
}
export function Wizard({
  steps,
  activeStep,
  onStepChange,
}: {
  steps: string[];
  activeStep: number;
  onStepChange?: (step: number) => void;
}) {
  return (
    <Stepper activeStep={activeStep} alternativeLabel aria-label="Progreso del formulario">
      {steps.map((label, index) => (
        <Step key={label} completed={index < activeStep}>
          <StepButton onClick={() => onStepChange?.(index)}>{label}</StepButton>
        </Step>
      ))}
    </Stepper>
  );
}
export function Timeline({
  items,
}: {
  items: { id: string; title: string; description?: string; date: string }[];
}) {
  return (
    <Stack component="ol" aria-label="Línea de tiempo" sx={{ listStyle: 'none', p: 0, m: 0 }}>
      {items.map((item) => (
        <Box
          component="li"
          key={item.id}
          sx={{ borderLeft: '2px solid', borderColor: 'divider', pl: 2, pb: 2 }}
        >
          <Typography variant="subtitle1">{item.title}</Typography>
          <Typography variant="body2" color="text.secondary">
            {item.date}
          </Typography>
          {item.description && <Typography variant="body2">{item.description}</Typography>}
        </Box>
      ))}
    </Stack>
  );
}
export function NextStepPanel({
  title = 'Siguiente paso',
  steps,
}: {
  title?: string;
  steps: string[];
}) {
  return (
    <Card component="aside" aria-label={title} sx={{ p: 2 }}>
      <Typography variant="h6">{title}</Typography>
      <Stack component="ul" sx={{ pl: 2, mb: 0 }}>
        {steps.map((step) => (
          <li key={step}>
            <Typography>{step}</Typography>
          </li>
        ))}
      </Stack>
    </Card>
  );
}
export function ConfirmWithReason({
  title = 'Confirma la acción',
  reasonLabel = 'Motivo',
  onConfirm,
  onCancel,
}: {
  title?: string;
  reasonLabel?: string;
  onConfirm: (reason: string) => void;
  onCancel?: () => void;
}) {
  const [reason, setReason] = React.useState('');
  return (
    <Card component="section" aria-label={title} sx={{ p: 2 }}>
      <Stack spacing={2}>
        <Typography variant="h6">{title}</Typography>
        <Field
          required
          label={reasonLabel}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          multiline
          minRows={2}
        />
        <Stack direction="row" gap={1}>
          <ButtonControl
            variant="contained"
            disabled={!reason.trim()}
            onClick={() => onConfirm(reason.trim())}
          >
            Confirmar
          </ButtonControl>
          {onCancel && (
            <ButtonControl variant="text" onClick={onCancel}>
              Cancelar
            </ButtonControl>
          )}
        </Stack>
      </Stack>
    </Card>
  );
}
export type UploadItem = {
  id: string;
  name: string;
  progress: number;
  status: 'pending' | 'uploading' | 'complete' | 'error';
};
export function UploadQueue({
  items,
  onRetry,
}: {
  items: UploadItem[];
  onRetry?: (id: string) => void;
}) {
  return (
    <Stack component="section" aria-label="Archivos por cargar" spacing={1}>
      {items.map((item) => (
        <Box key={item.id} sx={{ p: 1, border: 1, borderColor: 'divider', borderRadius: 1 }}>
          <Stack direction="row" alignItems="center" gap={1}>
            <span aria-hidden="true">↑</span>
            <Typography sx={{ flex: 1 }}>{item.name}</Typography>
            {item.status === 'complete' && (
              <span role="img" aria-label="Completado">
                ✓
              </span>
            )}
            {item.status === 'error' && onRetry && (
              <ButtonControl size="small" onClick={() => onRetry?.(item.id)}>
                Reintentar
              </ButtonControl>
            )}
          </Stack>
          {item.status === 'uploading' && (
            <LinearProgress
              variant="determinate"
              value={item.progress}
              aria-label={`Progreso de ${item.name}`}
            />
          )}
          {item.status === 'error' && <Alert severity="error">No se pudo cargar el archivo.</Alert>}
        </Box>
      ))}
    </Stack>
  );
}
export function Notifications({
  messages,
}: {
  messages: { id: string; text: string; severity: 'info' | 'success' | 'warning' | 'error' }[];
}) {
  return (
    <Stack role="region" aria-label="Notificaciones" spacing={1}>
      {messages.map((message) => (
        <Alert key={message.id} severity={message.severity}>
          {message.text}
        </Alert>
      ))}
    </Stack>
  );
}
