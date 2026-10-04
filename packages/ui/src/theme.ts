import { createTheme } from '@mui/material/styles';
import { opslogTokens } from './tokens';
export const opslogTheme = createTheme({
  palette: {
    mode: 'light',
    primary: { main: opslogTokens.colors.primary, dark: opslogTokens.colors.primaryHover },
    background: { default: opslogTokens.colors.background, paper: opslogTokens.colors.surface },
    text: { primary: opslogTokens.colors.text, secondary: opslogTokens.colors.textSecondary },
    divider: opslogTokens.colors.border,
    success: { main: opslogTokens.colors.success },
    warning: { main: opslogTokens.colors.warning },
    error: { main: opslogTokens.colors.danger },
  },
  typography: {
    fontFamily: opslogTokens.typography.fontFamily,
    fontSize: opslogTokens.typography.baseSize,
  },
  shape: { borderRadius: opslogTokens.shape.cardRadius },
  spacing: opslogTokens.spacing,
  components: {
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: {
        root: {
          borderRadius: opslogTokens.shape.controlRadius,
          textTransform: 'none',
          minHeight: 38,
        },
      },
    },
    MuiTextField: { defaultProps: { variant: 'outlined', size: 'small' } },
    MuiCard: {
      styleOverrides: {
        root: {
          border: `1px solid ${opslogTokens.colors.border}`,
          borderRadius: opslogTokens.shape.cardRadius,
        },
      },
    },
    MuiChip: { styleOverrides: { root: { borderRadius: opslogTokens.shape.controlRadius } } },
    MuiCssBaseline: {
      styleOverrides: {
        '*:focus-visible': { outline: `3px solid ${opslogTokens.colors.focus}`, outlineOffset: 2 },
      },
    },
  },
});
