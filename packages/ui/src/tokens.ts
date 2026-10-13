// OPSLOG design tokens v2 (ADR-0013): light shell, one blue accent, soft status tones. Every text/background
// pair used by the components below is at least WCAG AA (4.5:1); see tokens.test.ts.
export const opslogTokens = {
  colors: {
    background: '#F5F6F8',
    surface: '#FFFFFF',
    surfaceSubtle: '#F9FAFB',
    border: '#E5E7EB',
    borderStrong: '#D1D5DB',
    inputBorder: '#6B7280',
    text: '#111827',
    textSecondary: '#4B5563',
    textMuted: '#6B7280',
    navigation: '#FFFFFF',
    navigationText: '#374151',
    navigationGroup: '#4B5563',
    navigationActive: '#EDF2FF',
    navigationActiveText: '#1F43C2',
    primary: '#2952E3',
    primaryHover: '#1F43C2',
    primarySoft: '#EDF2FF',
    success: '#127A3E',
    successSoft: '#E7F6EC',
    warning: '#8A5300',
    warningSoft: '#FFF4D6',
    notice: '#B4430E',
    noticeSoft: '#FFEBDD',
    danger: '#C0261A',
    dangerSoft: '#FDECEA',
    focus: '#2952E3',
  },
  typography: {
    fontFamily: '"IBM Plex Sans", "Segoe UI", sans-serif',
    monoFamily: '"IBM Plex Mono", "Cascadia Code", monospace',
    baseSize: 14,
    sizes: { body: 14, small: 12, h1: 24, h2: 18, h3: 16 },
  },
  spacing: 8,
  spacingScale: [4, 8, 12, 16, 24, 32, 48],
  shape: { controlRadius: 8, cardRadius: 12 },
  shadow: {
    card: '0 1px 2px rgba(16, 24, 40, 0.05)',
    raised: '0 4px 12px rgba(16, 24, 40, 0.08)',
  },
  layout: {
    sidebarWidth: 248,
    topBarHeight: 60,
    contentPadding: 32,
    contentMaxWidth: 1360,
    rowHeight: 44,
    compactRowHeight: 32,
  },
} as const;
export const statusColors = {
  success: { foreground: opslogTokens.colors.success, background: opslogTokens.colors.successSoft },
  warning: { foreground: opslogTokens.colors.warning, background: opslogTokens.colors.warningSoft },
  notice: { foreground: opslogTokens.colors.notice, background: opslogTokens.colors.noticeSoft },
  danger: { foreground: opslogTokens.colors.danger, background: opslogTokens.colors.dangerSoft },
  neutral: {
    foreground: opslogTokens.colors.textSecondary,
    background: '#F2F4F7',
  },
} as const;
export type StatusTone = keyof typeof statusColors;
