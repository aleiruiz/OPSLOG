import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Lead } from './lead.js';
import { createFileLeadStore, leadsToCsv } from './store.js';

const lead: Lead = {
  nombre: 'Ana',
  empresa: 'Transportes "Norte"',
  correo: 'ana@example.mx',
  telefono: '',
  flotilla: '1-20',
  mensaje: '=HYPERLINK("http://x")',
  origen: '',
};

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('createFileLeadStore', () => {
  it('appends one JSON line per lead and lists newest first', async () => {
    dir = await mkdtemp(join(tmpdir(), 'leads-'));
    const path = join(dir, 'nested', 'leads.jsonl');
    let tick = 0;
    const store = createFileLeadStore(path, () => new Date(Date.UTC(2026, 9, 19, 8, tick++)));
    expect(await store.list()).toEqual([]);
    const [first, second] = await Promise.all([
      store.save(lead),
      store.save({ ...lead, nombre: 'Beto' }),
    ]);
    expect(first?.recibido).toBe('2026-10-19T08:00:00.000Z');
    expect((await readFile(path, 'utf8')).trim().split('\n')).toHaveLength(2);
    expect((await store.list()).map((item) => item.id)).toEqual([second?.id, first?.id]);
  });

  it('skips a torn line', async () => {
    dir = await mkdtemp(join(tmpdir(), 'leads-'));
    const path = join(dir, 'leads.jsonl');
    await writeFile(path, `${JSON.stringify({ ...lead, id: '1', recibido: 'x' })}\n{"nomb`);
    expect(await createFileLeadStore(path).list()).toHaveLength(1);
  });

  it('surfaces read errors other than a missing file', async () => {
    dir = await mkdtemp(join(tmpdir(), 'leads-'));
    await expect(createFileLeadStore(dir).list()).rejects.toThrow();
  });
});

describe('leadsToCsv', () => {
  it('quotes cells, defuses formulas and starts with a BOM', () => {
    const csv = leadsToCsv([{ ...lead, id: '1', recibido: '2026-10-19T08:00:00.000Z' }]);
    expect(csv.startsWith('﻿recibido,nombre,')).toBe(true);
    expect(csv).toContain('"Transportes ""Norte"""');
    expect(csv).toContain(`"'=HYPERLINK(""http://x"")"`);
  });
});
