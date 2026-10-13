import React from 'react';
import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';

export type InlineAlertSeverity = 'info' | 'success' | 'warning' | 'error';

/**
 * Message that sits inside a screen next to what it explains (a failed save, a conflict, a notice).
 * Errors and warnings are announced at once (`alert`); information and success wait for a pause
 * (`status`). The meaning never rests on colour: the severity icon and the text carry it.
 */
export function InlineAlert({
  severity = 'info',
  title,
  action,
  children,
}: {
  severity?: InlineAlertSeverity;
  title?: string;
  /** A recovery action beside the message (for example a button that reloads the data). */
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Alert
      severity={severity}
      role={severity === 'error' || severity === 'warning' ? 'alert' : 'status'}
      {...(action === undefined ? {} : { action })}
    >
      {title && <AlertTitle>{title}</AlertTitle>}
      {children}
    </Alert>
  );
}
