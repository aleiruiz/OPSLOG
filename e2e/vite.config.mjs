import react from '@vitejs/plugin-react';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const require = createRequire(import.meta.url);
const uiRoot = fileURLToPath(new URL('../packages/ui', import.meta.url));
const reactRoot = dirname(require.resolve('react/package.json', { paths: [uiRoot] }));
const reactDomRoot = dirname(require.resolve('react-dom/package.json', { paths: [uiRoot] }));

export default defineConfig({
  plugins: [react()],
  root: fileURLToPath(new URL('./browser-app', import.meta.url)),
  resolve: {
    alias: {
      '@opslog/ui': fileURLToPath(new URL('../packages/ui/src/index.ts', import.meta.url)),
      react: reactRoot,
      'react-dom': reactDomRoot,
    },
  },
});
