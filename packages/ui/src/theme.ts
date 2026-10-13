import { createTheme } from '@mui/material/styles';
import { opslogComponents } from './themeComponents';
import { opslogTokens } from './tokens';

const { colors, typography } = opslogTokens;
const px = (size: number) => `${size}px`;

export const opslogTheme = createTheme({
  palette: {
    mode: 'light',
    primary: { main: colors.primary, dark: colors.primaryHover, light: colors.primarySoft },
    background: { default: colors.background, paper: colors.surface },
    text: { primary: colors.text, secondary: colors.textSecondary },
    divider: colors.border,
    success: { main: colors.success, light: colors.successSoft },
    warning: { main: colors.warning, light: colors.warningSoft },
    error: { main: colors.danger, light: colors.dangerSoft },
    info: { main: colors.primary, light: colors.primarySoft },
  },
  typography: {
    fontFamily: typography.fontFamily,
    fontSize: typography.baseSize,
    fontWeightMedium: 500,
    fontWeightBold: 600,
    h1: {
      fontSize: px(typography.sizes.h1),
      fontWeight: 600,
      lineHeight: 1.3,
      letterSpacing: '-0.01em',
    },
    h2: { fontSize: px(typography.sizes.h2), fontWeight: 600, lineHeight: 1.4 },
    // Every heading below H2 uses the H3 size; body-level text uses the 14px base.
    ...Object.fromEntries(
      (['h3', 'h4', 'h5', 'h6'] as const).map((variant) => [
        variant,
        { fontSize: px(typography.sizes.h3), fontWeight: 600, lineHeight: 1.4 },
      ]),
    ),
    ...Object.fromEntries(
      (['subtitle1', 'subtitle2', 'body1', 'body2'] as const).map((variant) => [
        variant,
        { fontSize: px(typography.sizes.body), lineHeight: 1.5 },
      ]),
    ),
    subtitle1: { fontSize: px(typography.sizes.body), fontWeight: 600, lineHeight: 1.5 },
    button: { fontSize: px(typography.sizes.body), fontWeight: 600, textTransform: 'none' },
    caption: { fontSize: px(typography.sizes.small), lineHeight: 1.5 },
    overline: {
      fontSize: px(typography.sizes.small),
      fontWeight: 600,
      letterSpacing: '0.04em',
      lineHeight: 1.5,
    },
  },
  shape: { borderRadius: opslogTokens.shape.controlRadius },
  spacing: opslogTokens.spacing,
  components: opslogComponents,
});
