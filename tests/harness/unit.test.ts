import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tenantKey } from './tenant-key.js';

describe('workspace safety', () => {
  it('keeps tenant keys independent even when local ids collide', () => {
    expect(tenantKey('tenant-A', 1)).not.toBe(tenantKey('tenant-B', 1));
  });

  it('rejects an empty tenant key', () => {
    expect(() => tenantKey('', 1)).toThrow('tenant is required');
  });

  it('does not include secret-looking files in the repository tree', async () => {
    const { readdir } = await import('node:fs/promises');
    const forbidden = /(^|[._-])(env|secret|credential|token|password)([._-]|$)/i;
    const ignored = new Set(['.git', 'node_modules', 'coverage', 'dist', '.next']);
    const suspicious: string[] = [];
    async function scan(directory: string): Promise<void> {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (ignored.has(entry.name)) continue;
        const path = `${directory}/${entry.name}`;
        if (forbidden.test(entry.name) && entry.name !== '.env.example') suspicious.push(path);
        if (entry.isDirectory()) await scan(path);
      }
    }
    await scan('.');
    expect(suspicious).toEqual([]);
  });

  it('protects the adopted baseline bytes with their manifests', async () => {
    const root = process.cwd();
    for (const manifestName of ['BASELINE-1.0.json', 'BASELINE-1.1.json']) {
      const manifest = JSON.parse(
        await readFile(join(root, 'docs', 'baselines', manifestName), 'utf8'),
      ) as { files: Array<{ path: string; sha256: string }> };
      for (const file of manifest.files) {
        const bytes = await readFile(join(root, file.path));
        const canonical = bytes.toString('utf8').replace(/\r\n/g, '\n');
        const digest = createHash('sha256').update(canonical).digest('hex');
        expect(digest, `${manifestName}: ${file.path}`).toBe(file.sha256);
      }
    }
  });
});
