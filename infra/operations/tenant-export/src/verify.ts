import { createHash } from 'node:crypto';
import { chmodSync, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { once } from 'node:events';
import { FORMAT, MANIFEST_PATH, type Manifest } from './manifest.js';
import { readArchive } from './archive.js';
import { ExportError, type EntryDigest } from './types.js';

export interface VerifyReport {
  readonly ok: boolean;
  /** Fixed problem codes; empty when `ok`. */
  readonly problems: readonly string[];
  readonly entities: number;
  readonly rows: number;
  readonly objects: number;
  readonly complete: boolean;
  /** SHA-256 of the sealed file as read by this pass (extract requires its own pass to match). */
  readonly archiveSha256?: string;
}

interface Seen {
  readonly digest: EntryDigest;
  /** Newlines of the entry: for a JSON entity this gives its row count (`rowsOfJson`). */
  readonly newlines: number;
}

/** `[` + rows (one per line) + `]`: one newline when empty, rows + 2 otherwise (see `jsonChunks`). */
const rowsOfJson = (newlines: number): number => (newlines <= 1 ? 0 : newlines - 2);

/** Reads the whole archive once; `sink` receives every chunk of every entry (extract uses it). */
async function scan(
  archive: string,
  key: Buffer,
  sink?: (path: string, chunk: Buffer | undefined) => Promise<void>,
): Promise<{
  seen: Map<string, Seen>;
  manifest: Manifest | undefined;
  order: string[];
  fileSha256: string;
}> {
  const fileHash = createHash('sha256');
  const seen = new Map<string, Seen>();
  const order: string[] = [];
  let path = '';
  let hash = createHash('sha256');
  let bytes = 0;
  let newlines = 0;
  const manifestChunks: Buffer[] = [];
  for await (const event of readArchive(archive, key, (chunk) => fileHash.update(chunk))) {
    if (event.type === 'start') {
      path = event.path;
      hash = createHash('sha256');
      bytes = 0;
      newlines = 0;
      if (seen.has(path)) throw new ExportError('archive_corrupt');
      order.push(path);
      if (sink) await sink(path, undefined);
    } else if (event.type === 'data') {
      hash.update(event.chunk);
      bytes += event.chunk.length;
      for (let at = event.chunk.indexOf(10); at !== -1; at = event.chunk.indexOf(10, at + 1))
        newlines += 1;
      if (path === MANIFEST_PATH) manifestChunks.push(event.chunk);
      if (sink) await sink(path, event.chunk);
    } else seen.set(path, { digest: { path, bytes, sha256: hash.digest('hex') }, newlines });
  }
  let manifest: Manifest | undefined;
  try {
    manifest = JSON.parse(Buffer.concat(manifestChunks).toString('utf8')) as Manifest;
  } catch {
    manifest = undefined;
  }
  return { seen, manifest, order, fileSha256: fileHash.digest('hex') };
}

/**
 * Checks a sealed archive against its own manifest: every entry present with the recorded size and
 * SHA-256, no entry the manifest does not list, the manifest last, and the row count of each JSON
 * entity equal to the recorded one (reading the data back is the check that a re-import would
 * find the same counts). A wrong key or a damaged file throws `ExportError`.
 */
export async function verifyArchive(archive: string, key: Buffer): Promise<VerifyReport> {
  const { seen, manifest, order, fileSha256 } = await scan(archive, key);
  const problems: string[] = [];
  if (!manifest || manifest.format !== FORMAT || order[order.length - 1] !== MANIFEST_PATH) {
    return {
      ok: false,
      problems: ['manifest_missing'],
      entities: 0,
      rows: 0,
      objects: 0,
      complete: false,
      archiveSha256: fileSha256,
    };
  }
  const expected = new Map<string, EntryDigest>();
  let rows = 0;
  for (const entity of manifest.entities) {
    expected.set(entity.json.path, entity.json);
    expected.set(entity.csv.path, entity.csv);
    rows += entity.rows;
    const json = seen.get(entity.json.path);
    const count = json ? rowsOfJson(json.newlines) : -1;
    if (count !== entity.rows) problems.push(`rows_differ:${entity.table}`);
  }
  for (const entry of manifest.objects.entries) expected.set(entry.path, entry);
  for (const [path, want] of expected) {
    const got = seen.get(path)?.digest;
    if (!got) problems.push(`entry_missing:${path}`);
    else if (got.sha256 !== want.sha256 || got.bytes !== want.bytes)
      problems.push(`entry_differs:${path}`);
  }
  for (const path of order)
    if (path !== MANIFEST_PATH && !expected.has(path)) problems.push(`entry_unlisted:${path}`);
  return {
    ok: problems.length === 0,
    problems,
    entities: manifest.entities.length,
    rows,
    objects: manifest.objects.included,
    complete: manifest.complete,
    archiveSha256: fileSha256,
  };
}

/**
 * Writes the archive's entries into `outDir` (owner-only, must be empty or new) after verifying it.
 * The result is the plain company data: the operator decides where it goes and how it is protected.
 */
export async function extractArchive(
  archive: string,
  key: Buffer,
  outDir: string,
): Promise<VerifyReport> {
  const report = await verifyArchive(archive, key);
  if (!report.ok) throw new ExportError('manifest_mismatch');
  const root = resolve(outDir);
  if (existsSync(root) && readdirSync(root).length > 0) throw new ExportError('output_exists');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  let stream: ReturnType<typeof createWriteStream> | undefined;
  const second = await scan(archive, key, async (path, chunk) => {
    if (chunk === undefined) {
      if (stream) {
        stream.end();
        await once(stream, 'close');
      }
      const target = join(root, path);
      if (!target.startsWith(`${root}/`)) throw new ExportError('archive_corrupt');
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      stream = createWriteStream(target, { flags: 'wx', mode: 0o600 });
      return;
    }
    if (stream && !stream.write(chunk)) await once(stream, 'drain');
  });
  if (stream) {
    (stream as ReturnType<typeof createWriteStream>).end();
    await once(stream as ReturnType<typeof createWriteStream>, 'close');
  }
  // The file verified is the file extracted: a swap between the two passes leaves nothing behind.
  if (second.fileSha256 !== report.archiveSha256) {
    rmSync(root, { recursive: true, force: true });
    throw new ExportError('archive_corrupt');
  }
  return report;
}
