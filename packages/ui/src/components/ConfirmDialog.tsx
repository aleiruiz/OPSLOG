import React from 'react';
import Alert from '@mui/material/Alert';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import { Button } from './BaseComponents';

export type ConfirmDialogProps = {
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** The confirmation is running: both actions are disabled and the dialog cannot be dismissed. */
  busy?: boolean;
  /** A failure of the confirmed action, announced to assistive technology and kept inside the dialog. */
  error?: string;
  /** Optional recovery action shown next to the error (for example "Recargar datos"). */
  errorActionLabel?: string;
  onErrorAction?: () => void;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * Modal confirmation for a consequential action. Keyboard focus is trapped in the dialog, starts on the
 * safe choice (Cancelar), Escape cancels and focus returns to the control that opened it (MUI Modal).
 */
export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancelar',
  busy = false,
  error,
  errorActionLabel,
  onErrorAction,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const id = React.useId();
  return (
    <Dialog
      open
      onClose={() => {
        if (!busy) onCancel();
      }}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      fullWidth
      maxWidth="xs"
      TransitionProps={{
        // Dev-mode StrictMode runs the focus trap's effect twice and drops `autoFocus`; once the dialog has
        // opened, make sure the safe choice has focus unless the person already moved it to a control.
        onEntered: (node: HTMLElement) => {
          const active = document.activeElement;
          if (active && active !== node && node.contains(active)) return;
          node.querySelector<HTMLElement>('[data-initial-focus]')?.focus();
        },
      }}
    >
      <DialogTitle id={`${id}-title`} component="h2">
        {title}
      </DialogTitle>
      <DialogContent>
        <DialogContentText id={`${id}-description`}>{description}</DialogContentText>
        {error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}
      </DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap', gap: 1, px: 3, pb: 2 }}>
        {error && errorActionLabel && onErrorAction && (
          <Button variant="outlined" onClick={onErrorAction} disabled={busy}>
            {errorActionLabel}
          </Button>
        )}
        <Button variant="text" autoFocus data-initial-focus onClick={onCancel} disabled={busy}>
          {cancelLabel}
        </Button>
        <Button variant="contained" color="error" loading={busy} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
