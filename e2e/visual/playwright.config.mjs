import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const port = Number(process.env.STORYBOOK_STATIC_PORT ?? 6007); // serve.mjs reads the same variable

// Pixel-based visual regression of every Storybook story (SPECS §9.1, ADR-0010). Determinism: fixed
// viewport/DPR, reduced motion, Playwright-disabled animations, bundled IBM Plex fonts (waited for), fixed
// locale/timezone/colour profile and no font hinting or LCD antialiasing. Run `pnpm storybook:build` first
// (the `test:visual` script does).
// Baselines must be generated with the Chromium build pinned by @playwright/test (1.56.x -> 1194, the one CI
// installs with `playwright install`); regenerate them with `pnpm test:visual:update` after any Playwright bump.
// Tolerance is therefore tight: a strict per-pixel threshold and at most 0.2% differing pixels.
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  snapshotPathTemplate: '{testDir}/__snapshots__/{arg}-{projectName}{ext}',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0, // SPECS §9.1: no retries
  reporter: process.env.CI ? 'github' : 'list',
  expect: {
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      threshold: 0.1,
      maxDiffPixelRatio: 0.002,
    },
  },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    deviceScaleFactor: 1,
    locale: 'es-ES',
    timezoneId: 'UTC',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
    launchOptions: {
      // Optional override; by default Playwright uses its own installed Chromium.
      ...(process.env.OPSLOG_CHROMIUM_PATH
        ? { executablePath: process.env.OPSLOG_CHROMIUM_PATH }
        : {}),
      args: [
        '--font-render-hinting=none',
        '--disable-lcd-text',
        '--disable-font-subpixel-positioning',
        '--force-color-profile=srgb',
        '--hide-scrollbars',
      ],
    },
  },
  webServer: {
    command: 'node e2e/visual/serve.mjs',
    env: { STORYBOOK_STATIC_PORT: String(port) },
    cwd: repositoryRoot,
    url: `http://127.0.0.1:${port}/index.json`,
    reuseExistingServer: false,
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 800 } } },
    { name: 'mobile', use: { viewport: { width: 360, height: 800 } } },
  ],
});
