// @vitest-environment node
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { build, type InlineConfig } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The mock API and the fake identity provider must never reach a production bundle (SPECS §9.2).
 * This builds the real entry point (`index.html` → `main.tsx` and everything it imports) in memory,
 * once in production mode and once in development mode as a positive control, and searches the
 * emitted JavaScript.
 */
const fromHere = (path: string) => fileURLToPath(new URL(path, import.meta.url));

afterEach(() => vi.unstubAllEnvs());

async function bundle(mode: 'production' | 'development'): Promise<string> {
  // Vitest runs with NODE_ENV=test, which Vite would treat as a development build.
  vi.stubEnv('NODE_ENV', mode);
  const config: InlineConfig = {
    configFile: false,
    root: fromHere('.'),
    mode,
    logLevel: 'silent',
    plugins: [react()],
    resolve: {
      alias: {
        '@opslog/ui': fromHere('../../../packages/ui/src/index.ts'),
        '@opslog/contracts': fromHere('../../../packages/contracts/src/index.ts'),
      },
      dedupe: ['react', 'react-dom', '@emotion/react', '@emotion/styled', '@mui/material'],
    },
    build: {
      write: false,
      minify: false,
      reportCompressedSize: false,
      sourcemap: false,
      // The application's own modules are bundled as in production; third-party packages (React,
      // MUI, the UI kit, the contracts) are left external. That keeps the build fast and cannot
      // hide a mock, because none of them contains one.
      rollupOptions: { external: (id) => !/^[./\0]/.test(id) && !id.startsWith('/') },
    },
  };
  const result = await build(config);
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((item) =>
    'output' in item ? item.output : [],
  );
  return outputs
    .filter((output) => output.type === 'chunk')
    .map((output) => output.code)
    .join('\n');
}

// What identifies the development-only modules in emitted code.
const DEV_ONLY = ['createMockApi', 'createFakeOidc', 'fake-code', 'createHttpApi', 'cuenta-admin'];

describe('web production bundle', () => {
  it('contains no mock API, fake identity provider or BFF client, and fails closed', async () => {
    const production = await bundle('production');
    for (const marker of DEV_ONLY) expect(production, marker).not.toContain(marker);
    expect(production).toContain('El inicio de sesión no está disponible en esta compilación.');
  }, 120_000);

  it('does contain them in a development build, so the check above is not vacuous', async () => {
    const development = await bundle('development');
    for (const marker of DEV_ONLY) expect(development, marker).toContain(marker);
  }, 120_000);
});
