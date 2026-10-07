import { fileURLToPath } from 'node:url';
import type { StorybookConfig } from '@storybook/react-vite';

const fromRoot = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));

// Storybook runtime for the OPSLOG design system (SPECS §9.1, ADR-0010). Offline by construction: no addons
// fetched at runtime, telemetry and update checks disabled, fonts bundled from @fontsource.
const config: StorybookConfig = {
  // Design-system stories live next to the components; screen stories live next to the screens of the web app.
  stories: [
    '../src/**/*.stories.tsx',
    '../../../apps/web/vehicles/**/*.stories.tsx',
    '../../../apps/web/areas/**/*.stories.tsx',
    '../../../apps/web/documents/**/*.stories.tsx',
    '../../../apps/web/insurance/**/*.stories.tsx',
    '../../../apps/web/employees/**/*.stories.tsx',
    '../../../apps/web/alerts/**/*.stories.tsx',
    '../../../apps/web/assignments/**/*.stories.tsx',
    '../../../apps/web/imports/**/*.stories.tsx',
  ],
  framework: { name: '@storybook/react-vite', options: {} },
  core: { disableTelemetry: true, disableWhatsNewNotifications: true, enableCrashReports: false },
  typescript: { reactDocgen: false },
  viteFinal: (viteConfig) => ({
    ...viteConfig,
    resolve: {
      ...viteConfig.resolve,
      // Screen stories import the workspace packages the way apps/web does (tsconfig paths).
      alias: [
        ...(Array.isArray(viteConfig.resolve?.alias)
          ? viteConfig.resolve.alias
          : Object.entries(viteConfig.resolve?.alias ?? {}).map(([find, replacement]) => ({
              find,
              replacement,
            }))),
        { find: '@opslog/ui', replacement: fromRoot('packages/ui/src/index.ts') },
        { find: '@opslog/contracts', replacement: fromRoot('packages/contracts/src/index.ts') },
      ],
      dedupe: [
        ...(viteConfig.resolve?.dedupe ?? []),
        'react',
        'react-dom',
        '@emotion/react',
        '@emotion/styled',
        '@mui/material',
      ],
    },
    build: {
      ...viteConfig.build,
      // Rollup 4.64 tree-shaking of the @mui/material barrel takes ~8 minutes (measured, 100% CPU); a static
      // story bundle gains nothing from it, so skip it: the build drops to seconds.
      rollupOptions: { ...viteConfig.build?.rollupOptions, treeshake: false },
    },
  }),
};

export default config;
