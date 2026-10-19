// Bundles the landing server into one dependency-free file for the container image.
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const here = (path) => fileURLToPath(new URL(path, import.meta.url));

await build({
  configFile: false,
  root: here('.'),
  logLevel: 'warn',
  // The page is copied into the image on its own (deploy/Dockerfile).
  publicDir: false,
  ssr: { noExternal: true, target: 'node' },
  build: {
    ssr: here('src/main.ts'),
    outDir: here('bundle'),
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    sourcemap: false,
    rollupOptions: { output: { entryFileNames: 'landing.mjs', format: 'es' } },
  },
});
