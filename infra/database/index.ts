import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Migration } from '../../packages/persistence/tenancy/src/index.js';

export async function loadTenantMigrations(
  baseDirectory = dirname(fileURLToPath(import.meta.url)),
): Promise<readonly Migration[]> {
  const names = ['001_tenant_operational.sql', '002_tenant_membership_projection.sql'];
  return Promise.all(names.map(async (name) => ({ name, sql: await readFile(join(baseDirectory, name), 'utf8') })));
}
