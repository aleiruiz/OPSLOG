import type { StorybookConfig } from '@storybook/react-vite';

// Storybook runtime for the OPSLOG design system (SPECS §9.1, ADR-0010). Offline by construction: no addons
// fetched at runtime, telemetry and update checks disabled, fonts bundled from @fontsource.
const config: StorybookConfig = {
  stories: ['../src/**/*.stories.tsx'],
  framework: { name: '@storybook/react-vite', options: {} },
  core: { disableTelemetry: true, disableWhatsNewNotifications: true, enableCrashReports: false },
  typescript: { reactDocgen: false },
  viteFinal: (viteConfig) => ({
    ...viteConfig,
    build: {
      ...viteConfig.build,
      // Rollup 4.64 tree-shaking of the @mui/material barrel takes ~8 minutes (measured, 100% CPU); a static
      // story bundle gains nothing from it, so skip it: the build drops to seconds.
      rollupOptions: { ...viteConfig.build?.rollupOptions, treeshake: false },
    },
  }),
};

export default config;
