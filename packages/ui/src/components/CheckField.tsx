import React from 'react';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';

/** A labelled checkbox: the whole label is the click target and the state is announced by the browser. */
export function CheckField({
  label,
  checked,
  disabled = false,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <FormControlLabel
      label={label}
      disabled={disabled}
      control={<Checkbox checked={checked} onChange={(event) => onChange(event.target.checked)} />}
    />
  );
}
