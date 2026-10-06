import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@opslog/ui': fromRoot('../../packages/ui/src/index.ts'),
      '@opslog/contracts': fromRoot('../../packages/contracts/src/index.ts'),
    },
    dedupe: ['react', 'react-dom', '@emotion/react', '@emotion/styled', '@mui/material'],
  },
  test: {
    environment: 'jsdom',
    testTimeout: 10000,
    setupFiles: ['./app/test/setup.ts'],
    include: ['app/**/*.test.{ts,tsx}', 'auth/**/*.test.{ts,tsx}', 'settings/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: ['app/**/*.{ts,tsx}', 'auth/**/*.{ts,tsx}', 'settings/**/*.{ts,tsx}'],
      exclude: ['**/*.test.*', 'app/test/**', 'app/main.tsx', 'app/types.ts'],
    },
  },
});
