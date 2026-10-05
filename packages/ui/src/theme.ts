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
    fontWeightMedium: 600,
    fontWeightBold: 600,
    h1: { fontSize: `${opslogTokens.typography.sizes.h1}px`, fontWeight: 600 },
    // Every heading below H1 uses the H2 size; body-level text uses the 14px base (SPECS §8).
    ...Object.fromEntries(
      (['h2', 'h3', 'h4', 'h5', 'h6'] as const).map((variant) => [
        variant,
        { fontSize: `${opslogTokens.typography.sizes.h2}px`, fontWeight: 600 },
      ]),
    ),
    ...Object.fromEntries(
      (['subtitle1', 'subtitle2', 'body1', 'body2', 'button'] as const).map((variant) => [
        variant,
        { fontSize: `${opslogTokens.typography.sizes.body}px` },
      ]),
    ),
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
    MuiOutlinedInput: {
      styleOverrides: {
        notchedOutline: { borderColor: opslogTokens.colors.inputBorder },
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
        '*:focus-visible': {
          outline: `3px solid ${opslogTokens.colors.focus} !important`,
          outlineOffset: 2,
        },
        '.sr-only': {
          position: 'absolute',
          width: 1,
          height: 1,
          margin: -1,
          padding: 0,
          overflow: 'hidden',
          clip: 'rect(0 0 0 0)',
          whiteSpace: 'nowrap',
          border: 0,
        },
      },
    },
  },
});
