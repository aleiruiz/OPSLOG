import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Lead } from './lead.js';

export interface StoredLead extends Lead {
  readonly id: string;
  /** ISO 8601, UTC. */
  readonly recibido: string;
}

export interface LeadStore {
  save(lead: Lead): Promise<StoredLead>;
  /** Newest first. */
  list(): Promise<readonly StoredLead[]>;
}

/**
 * One JSON object per line in a file on the container volume. Appends are serialized, so lines never
 * interleave; a demo-request volume never needs a database.
 */
export function createFileLeadStore(path: string, now: () => Date = () => new Date()): LeadStore {
  let queue: Promise<unknown> = mkdir(dirname(path), { recursive: true });
  return {
    save(lead) {
      const stored: StoredLead = { id: randomUUID(), recibido: now().toISOString(), ...lead };
      const write = queue.then(() => appendFile(path, `${JSON.stringify(stored)}\n`, 'utf8'));
      queue = write.catch(() => undefined);
      return write.then(() => stored);
    },
    async list() {
      let raw: string;
      try {
        raw = await readFile(path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
      const leads: StoredLead[] = [];
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          leads.push(JSON.parse(line) as StoredLead);
        } catch {
          // A torn last line (crash mid-write) is skipped, not fatal.
        }
      }
      return leads.reverse();
    },
  };
}

const CSV_COLUMNS = [
  'recibido',
  'nombre',
  'empresa',
  'correo',
  'telefono',
  'flotilla',
  'mensaje',
  'origen',
] as const;

/** Quotes a cell and defuses spreadsheet formulas (a cell starting with = + - @ is prefixed with '). */
function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** CSV with a UTF-8 BOM so Excel opens accents correctly. */
export function leadsToCsv(leads: readonly StoredLead[]): string {
  const rows = leads.map((lead) => CSV_COLUMNS.map((column) => csvCell(lead[column])).join(','));
  return `﻿${CSV_COLUMNS.join(',')}\r\n${rows.map((row) => `${row}\r\n`).join('')}`;
}
