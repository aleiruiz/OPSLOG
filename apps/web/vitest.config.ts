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
    include: [
      'alerts/**/*.test.{ts,tsx}',
      'api/**/*.test.{ts,tsx}',
      'app/**/*.test.{ts,tsx}',
      'areas/**/*.test.{ts,tsx}',
      'auth/**/*.test.{ts,tsx}',
      'documents/**/*.test.{ts,tsx}',
      'insurance/**/*.test.{ts,tsx}',
      'assignments/**/*.test.{ts,tsx}',
      'imports/**/*.test.{ts,tsx}',
      'employees/**/*.test.{ts,tsx}',
      'settings/**/*.test.{ts,tsx}',
      'vehicles/**/*.test.{ts,tsx}',
    ],
    coverage: {
      provider: 'v8',
      include: [
        'alerts/**/*.{ts,tsx}',
        'api/**/*.{ts,tsx}',
        'app/**/*.{ts,tsx}',
        'areas/**/*.{ts,tsx}',
        'auth/**/*.{ts,tsx}',
        'documents/**/*.{ts,tsx}',
        'insurance/**/*.{ts,tsx}',
        'assignments/**/*.{ts,tsx}',
        'imports/**/*.{ts,tsx}',
        'employees/**/*.{ts,tsx}',
        'settings/**/*.{ts,tsx}',
        'vehicles/**/*.{ts,tsx}',
      ],
      exclude: ['**/*.test.*', '**/*.stories.tsx', 'app/test/**', 'app/main.tsx', 'app/types.ts'],
    },
  },
});
