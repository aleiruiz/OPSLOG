import Box from '@mui/material/Box';
import React from 'react';

/** The numbers behind a chart as a table: the text equivalent of the bars, collapsed by default. */
export function DataDetails({
  summary,
  caption,
  head,
  rows,
}: {
  summary: string;
  caption: string;
  head: readonly string[];
  rows: readonly (readonly string[])[];
}) {
  return (
    <Box component="details" sx={{ fontSize: 13 }}>
      <Box component="summary" sx={{ cursor: 'pointer', color: 'primary.main', fontWeight: 500 }}>
        {summary}
      </Box>
      <Box sx={{ maxHeight: 220, overflow: 'auto', mt: 1 }}>
        <Box component="table" sx={{ borderCollapse: 'collapse', width: '100%' }}>
          <caption style={{ textAlign: 'left', padding: '0 0 4px' }}>{caption}</caption>
          <thead>
            <tr>
              {head.map((cell) => (
                <Box
                  component="th"
                  scope="col"
                  key={cell}
                  sx={{
                    textAlign: 'left',
                    py: 0.5,
                    pr: 2,
                    borderBottom: 1,
                    borderColor: 'divider',
                  }}
                >
                  {cell}
                </Box>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row[0]}>
                {row.map((cell, index) => (
                  <Box
                    component={index === 0 ? 'th' : 'td'}
                    {...(index === 0 ? { scope: 'row' } : {})}
                    key={cell + String(index)}
                    sx={{ textAlign: 'left', fontWeight: 400, py: 0.5, pr: 2 }}
                  >
                    {cell}
                  </Box>
                ))}
              </tr>
            ))}
          </tbody>
        </Box>
      </Box>
    </Box>
  );
}
