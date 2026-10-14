// Bundles the server (workspace code and its npm dependencies) into one file for the container image.
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
        const entry = join(path, 'src/index.ts');
        if (manifest.name?.startsWith('@opslog/') && existsSync(entry))
          sources.set(manifest.name, entry);
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
    ssr: here('src/main.ts'),
    outDir: here('bundle'),
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    sourcemap: false,
    rollupOptions: {
      // Optional drivers of TypeORM that this deployment never loads.
      external: [
        /^(pg|pg-native|pg-query-stream|oracledb|sqlite3|better-sqlite3|sql\.js|mongodb|mssql|mysql|redis|ioredis|react-native-sqlite-storage|typeorm-aurora-data-api-driver|@sap\/hana-client|hdb-pool|@google-cloud\/spanner)(\/|$)/,
      ],
      output: { entryFileNames: 'server.mjs', format: 'es' },
    },
  },
});
