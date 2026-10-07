import React from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
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
      label={label}
      {...(id === undefined ? {} : { id })}
      {...(error === undefined ? {} : { error })}
      {...(helperText === undefined && description === undefined
        ? {}
        : { helperText: helperText ?? description })}
      {...(helperText === undefined && description === undefined
        ? {}
        : {
            FormHelperTextProps: { id: helperId },
            inputProps: { 'aria-describedby': helperId, ...props.inputProps },
          })}
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
