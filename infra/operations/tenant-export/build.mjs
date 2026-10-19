// Bundles the company export tool (workspace code and its npm dependencies) into one file:
//   node infra/operations/tenant-export/build.mjs  ->  infra/operations/tenant-export/bundle/tenant-export.mjs
// The api image carries it next to server.mjs, so it runs inside the compose network:
//   docker compose exec -e ... api node tenant-export.mjs export --out /tmp/out --operator <handle> --reason <ticket>
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const repoRoot = here('../../../');

/** Workspace packages are bundled from their TypeScript source (`src/index.ts`), not from tsc output. */
function workspaceSources() {
  const sources = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
      const path = join(dir, entry);
      if (!statSync(path).isDirectory()) continue;
      try {
        const manifest = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
        const source = join(path, 'src/index.ts');
        if (manifest.name?.startsWith('@opslog/') && existsSync(source))
          sources.set(manifest.name, source);
      } catch {
        // Not a package directory.
      }
      walk(path);
    }
  };
  for (const top of ['apps', 'packages', 'infra']) walk(join(repoRoot, top));
  return sources;
}

const sources = workspaceSources();
const workspacePlugin = {
  name: 'opslog-workspace-sources',
  enforce: 'pre',
  resolveId: (id) => sources.get(id) ?? null,
};

await build({
  configFile: false,
  root: here('.'),
  logLevel: 'warn',
  plugins: [workspacePlugin],
  ssr: { noExternal: true, target: 'node' },
  build: {
    ssr: here('src/cli.ts'),
    outDir: here('bundle'),
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    sourcemap: false,
    rollupOptions: { output: { entryFileNames: 'tenant-export.mjs', format: 'es' } },
  },
});
