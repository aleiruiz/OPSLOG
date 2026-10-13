import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';

export interface DescriptionItem {
  readonly label: string;
  readonly value: React.ReactNode;
}

/**
 * Label/value pairs of a record (`<dl>`). Each pair is a cell of a grid: one column on phones and
 * `columns` (default 2) from 900px, with the label above its value.
 */
export function DescriptionList({
  items,
  columns = 2,
}: {
  items: readonly DescriptionItem[];
  columns?: 1 | 2 | 3;
}) {
  return (
    <Box
      component="dl"
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: '1fr', md: `repeat(${columns}, minmax(0, 1fr))` },
        columnGap: 3,
        rowGap: 2.5,
        m: 0,
      }}
    >
      {items.map(({ label, value }) => (
        <Box key={label} sx={{ minWidth: 0 }}>
          <Typography component="dt" variant="caption" color="text.secondary" display="block">
            {label}
          </Typography>
          <Typography
            component="dd"
            variant="body1"
            sx={{ m: 0, mt: 0.25, overflowWrap: 'anywhere' }}
          >
            {value}
          </Typography>
        </Box>
      ))}
    </Box>
  );
}
