// Production build of the web shell (static files for the container image). Development-only
// modules (mock API, fake identity provider) are not reachable from a production build.
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const here = (path) => fileURLToPath(new URL(path, import.meta.url));

await build({
  configFile: false,
  root: here('app'),
  mode: 'production',
  plugins: [react()],
  resolve: {
    alias: {
      '@opslog/ui': here('../../packages/ui/src/index.ts'),
      '@opslog/contracts': here('../../packages/contracts/src/index.ts'),
    },
    dedupe: ['react', 'react-dom', '@emotion/react', '@emotion/styled', '@mui/material'],
  },
  build: { outDir: here('dist-web'), emptyOutDir: true, sourcemap: false },
});
