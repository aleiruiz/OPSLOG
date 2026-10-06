import React from 'react';
import type { Preview } from '@storybook/react';
import { CssBaseline, ThemeProvider } from '@mui/material';
import '../src/fonts';
import { opslogTheme } from '../src/theme';

const preview: Preview = {
  parameters: { layout: 'padded', controls: { disable: true } },
  decorators: [
    (Story) => (
      <ThemeProvider theme={opslogTheme}>
        <CssBaseline />
        <Story />
      </ThemeProvider>
    ),
  ],
};

export default preview;
