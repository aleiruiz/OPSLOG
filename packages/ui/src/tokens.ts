export const opslogTokens = {
  colors: {
    background: '#F3F4F6',
    surface: '#FFFFFF',
    border: '#E3E6EB',
    borderStrong: '#C9CFD8',
    text: '#171A1F',
    textSecondary: '#3E4650',
    textMuted: '#5C6571',
    navigation: '#0F1420',
    navigationActive: '#243052',
    primary: '#1F4FD8',
    primaryHover: '#1A41B2',
    primarySoft: '#E8EEFC',
    success: '#1B7A3E',
    successSoft: '#E1F5E8',
    warning: '#7A5000',
    warningSoft: '#FFF1CF',
    notice: '#A3420A',
    noticeSoft: '#FFE6D5',
    danger: '#B42318',
    dangerSoft: '#FEE4E2',
    focus: '#1F4FD8',
  },
  typography: {
    fontFamily: '"IBM Plex Sans", "Segoe UI", sans-serif',
    monoFamily: '"IBM Plex Mono", "Cascadia Code", monospace',
    baseSize: 14,
  },
  spacing: 8,
  shape: { controlRadius: 6, cardRadius: 8 },
  layout: { sidebarWidth: 232, contentPadding: 24, rowHeight: 38, compactRowHeight: 30 },
} as const;
export const statusColors = {
  success: { foreground: opslogTokens.colors.success, background: opslogTokens.colors.successSoft },
  warning: { foreground: opslogTokens.colors.warning, background: opslogTokens.colors.warningSoft },
  notice: { foreground: opslogTokens.colors.notice, background: opslogTokens.colors.noticeSoft },
  danger: { foreground: opslogTokens.colors.danger, background: opslogTokens.colors.dangerSoft },
  neutral: {
    foreground: opslogTokens.colors.textSecondary,
    background: opslogTokens.colors.background,
  },
} as const;
export type StatusTone = keyof typeof statusColors;
