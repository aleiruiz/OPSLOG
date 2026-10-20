import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import React from 'react';
import { Button, InlineAlert, Panel } from '@opslog/ui';
import { copy } from './labels';

/** The secret in plain text, once. It lives only in this component's props and is dropped when the person confirms. */
export function SecretNotice({
  secret,
  onDone,
}: {
  readonly secret: string;
  readonly onDone: () => void;
}) {
  const [copied, setCopied] = React.useState(false);
  const copySecret = async () => {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <Panel title={copy.secretTitle} description={copy.secretHelp}>
      <Box
        component="code"
        aria-label="Secreto de firma"
        sx={{ display: 'block', wordBreak: 'break-all', p: 1.5, bgcolor: 'action.hover' }}
      >
        {secret}
      </Box>
      <Box sx={{ mt: 2, display: 'flex', gap: 2, alignItems: 'center' }}>
        <Button variant="outlined" onClick={() => void copySecret()}>
          {copy.secretCopy}
        </Button>
        <Button onClick={onDone}>{copy.secretDone}</Button>
        {copied && <Typography role="status">{copy.secretCopied}</Typography>}
      </Box>
      <InlineAlert severity="warning">{copy.secretHelp}</InlineAlert>
    </Panel>
  );
}
