import React from 'react';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

/**
 * Card that groups one block of a screen: an optional header (title, description, actions), an optional
 * toolbar (filters) and the content. `flush` removes the content padding so a table reaches the edges.
 */
export function Panel({
  title,
  description,
  actions,
  toolbar,
  flush = false,
  headingLevel = 2,
  children,
}: {
  title?: string;
  description?: string;
  actions?: React.ReactNode;
  toolbar?: React.ReactNode;
  flush?: boolean;
  headingLevel?: 2 | 3;
  children?: React.ReactNode;
}) {
  const headingId = React.useId();
  const hasHeader = title !== undefined || actions !== undefined;
  return (
    <Card
      component="section"
      {...(title === undefined ? {} : { 'aria-labelledby': headingId })}
      sx={{ mb: 3, overflow: 'hidden' }}
    >
      {hasHeader && (
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          justifyContent="space-between"
          alignItems={{ sm: 'center' }}
          gap={1.5}
          sx={{ px: { xs: 2, sm: 2.5 }, pt: 2, pb: toolbar || !flush ? 0 : 2 }}
        >
          <Box sx={{ minWidth: 0 }}>
            {title !== undefined && (
              <Typography id={headingId} component={`h${headingLevel}`} variant="h2">
                {title}
              </Typography>
            )}
            {description && (
              <Typography variant="body2" color="text.secondary">
                {description}
              </Typography>
            )}
          </Box>
          {actions && (
            <Stack direction="row" gap={1} flexWrap="wrap">
              {actions}
            </Stack>
          )}
        </Stack>
      )}
      {toolbar && (
        <Box
          sx={{
            px: { xs: 2, sm: 2.5 },
            py: 2,
            borderBottom: flush ? 1 : 0,
            borderColor: 'divider',
          }}
        >
          {toolbar}
        </Box>
      )}
      <Box sx={flush ? {} : { px: { xs: 2, sm: 2.5 }, py: 2 }}>{children}</Box>
    </Card>
  );
}
