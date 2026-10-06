import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const port = 6007;

// Pixel-based visual regression of every Storybook story (SPECS §9.1, ADR-0010). Determinism: fixed
// viewport/DPR, reduced motion, Playwright-disabled animations, bundled IBM Plex fonts (waited for), fixed
// locale/timezone/colour profile and no font hinting or LCD antialiasing. Run `pnpm storybook:build` first
// (the `test:visual` script does).
// Tolerance: the committed baselines were generated with Chromium 1194 (local /opt/pw-browsers) while CI
// installs the build pinned by Playwright 1.55.1 (1193); their antialiasing differs by ~1% of pixels on the
// densest story. The per-pixel colour threshold stays strict (0.1) and the allowed differing ratio is 2%.
// When feasible, regenerate the baselines with the CI browser version (`pnpm test:visual:update`) and tighten
// maxDiffPixelRatio again.
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
      maxDiffPixelRatio: 0.02,
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
    cwd: repositoryRoot,
    url: `http://127.0.0.1:${port}/index.json`,
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 800 } } },
    { name: 'mobile', use: { viewport: { width: 360, height: 800 } } },
  ],
});
