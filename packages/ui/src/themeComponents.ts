import type { Components, Theme } from '@mui/material/styles';
import { opslogTokens } from './tokens';

const { colors, shape, shadow, layout, typography } = opslogTokens;

/** Component defaults and overrides of the OPSLOG theme (ADR-0013). Colours only come from the tokens. */
export const opslogComponents: Components<Omit<Theme, 'components'>> = {
  MuiButton: {
    defaultProps: { disableElevation: true },
    styleOverrides: {
      root: {
        borderRadius: shape.controlRadius,
        textTransform: 'none',
        minHeight: 38,
        paddingInline: 16,
      },
      outlined: {
        borderColor: colors.borderStrong,
        backgroundColor: colors.surface,
        '&:hover': { borderColor: colors.inputBorder, backgroundColor: colors.surfaceSubtle },
      },
      outlinedPrimary: { color: colors.text },
      sizeSmall: { minHeight: 32, paddingInline: 12 },
    },
  },
  MuiIconButton: { styleOverrides: { root: { borderRadius: shape.controlRadius } } },
  MuiOutlinedInput: {
    styleOverrides: {
      root: { backgroundColor: colors.surface, borderRadius: shape.controlRadius },
      notchedOutline: { borderColor: colors.inputBorder },
    },
  },
  MuiInputLabel: { styleOverrides: { root: { color: colors.textSecondary } } },
  MuiTextField: { defaultProps: { variant: 'outlined', size: 'small' } },
  MuiPaper: {
    defaultProps: { elevation: 0 },
    styleOverrides: { rounded: { borderRadius: shape.cardRadius } },
  },
  MuiCard: {
    defaultProps: { variant: 'outlined' },
    styleOverrides: {
      root: {
        border: `1px solid ${colors.border}`,
        borderRadius: shape.cardRadius,
        boxShadow: shadow.card,
      },
    },
  },
  MuiChip: {
    styleOverrides: {
      root: { borderRadius: 999, fontWeight: 600 },
      sizeSmall: { height: 24, fontSize: typography.sizes.small },
    },
  },
  MuiAlert: {
    styleOverrides: {
      root: { borderRadius: shape.cardRadius, border: '1px solid', alignItems: 'flex-start' },
      standardInfo: {
        backgroundColor: colors.primarySoft,
        borderColor: '#C7D4FB',
        color: colors.text,
      },
      standardSuccess: {
        backgroundColor: colors.successSoft,
        borderColor: '#B7E2C5',
        color: colors.text,
      },
      standardWarning: {
        backgroundColor: colors.warningSoft,
        borderColor: '#F4D58D',
        color: colors.text,
      },
      standardError: {
        backgroundColor: colors.dangerSoft,
        borderColor: '#F5C2BD',
        color: colors.text,
      },
    },
  },
  MuiTable: { styleOverrides: { root: { borderCollapse: 'separate', borderSpacing: 0 } } },
  MuiTableCell: {
    styleOverrides: {
      root: { borderBottom: `1px solid ${colors.border}`, paddingBlock: 10, paddingInline: 16 },
      head: {
        backgroundColor: colors.surfaceSubtle,
        color: colors.textSecondary,
        fontSize: typography.sizes.small,
        fontWeight: 600,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        whiteSpace: 'nowrap',
      },
    },
  },
  MuiTableRow: {
    styleOverrides: {
      root: {
        height: layout.rowHeight,
        '&:last-child > td': { borderBottom: 0 },
        '&.MuiTableRow-hover:hover': { backgroundColor: colors.surfaceSubtle },
      },
    },
  },
  MuiTab: { styleOverrides: { root: { textTransform: 'none', fontWeight: 600, minHeight: 44 } } },
  MuiTabs: {
    styleOverrides: { root: { minHeight: 44, borderBottom: `1px solid ${colors.border}` } },
  },
  MuiDialog: {
    styleOverrides: { paper: { borderRadius: shape.cardRadius, boxShadow: shadow.raised } },
  },
  MuiLink: { defaultProps: { underline: 'hover' } },
  MuiCssBaseline: {
    styleOverrides: {
      body: { backgroundColor: colors.background },
      '*:focus-visible': {
        outline: `3px solid ${colors.focus} !important`,
        outlineOffset: 2,
      },
      // Containers that only receive focus programmatically (the main region after navigation) do not
      // need a ring: it framed the whole page after every route change.
      '[tabindex="-1"]:focus': { outline: 'none !important' },
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
};
