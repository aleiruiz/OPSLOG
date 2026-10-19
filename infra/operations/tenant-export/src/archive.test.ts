import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArchiveWriter, parseArchiveKey, readArchive } from './archive.js';
import { ExportError } from './types.js';

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'opslog-archive-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const key = randomBytes(32);

async function write(path: string, entries: Record<string, Buffer>, k = key): Promise<string> {
  const writer = await ArchiveWriter.create(path, k);
  for (const [name, bytes] of Object.entries(entries)) await writer.add(name, [bytes]);
  return (await writer.finish()).sha256;
}

async function collect(path: string, k = key): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer[]>();
  let current = '';
  for await (const event of readArchive(path, k)) {
    if (event.type === 'start') out.set((current = event.path), []);
    else if (event.type === 'data') out.get(current)?.push(event.chunk);
  }
  return new Map([...out].map(([name, chunks]) => [name, Buffer.concat(chunks)]));
}

describe('sealed archive', () => {
  it('round-trips entries across chunk boundaries and reports the sealed file hash', async () => {
    const big = randomBytes(300_000);
    const path = join(dir, 'a.opsx');
    const sha = await write(path, {
      'entities/a.json': Buffer.from('[]\n'),
      'objects/x': big,
      empty: Buffer.alloc(0),
    });
    const entries = await collect(path);
    expect([...entries.keys()]).toEqual(['entities/a.json', 'objects/x', 'empty']);
    expect(entries.get('objects/x')?.equals(big)).toBe(true);
    expect(entries.get('empty')?.length).toBe(0);
    const { createHash } = await import('node:crypto');
    expect(createHash('sha256').update(readFileSync(path)).digest('hex')).toBe(sha);
  });

  it('never writes the content in clear', async () => {
    const path = join(dir, 'a.opsx');
    await write(path, { 'entities/a.json': Buffer.from('PLAINTEXT-MARKER-0123456789') });
    expect(readFileSync(path).includes('PLAINTEXT-MARKER')).toBe(false);
    expect(readFileSync(path).subarray(0, 8).toString('latin1')).toBe('OPSXPRT1');
  });

  it('rejects the wrong key as a key problem and a damaged file as corrupt', async () => {
    const path = join(dir, 'a.opsx');
    await write(path, { a: randomBytes(150_000) });
    await expect(collect(path, randomBytes(32))).rejects.toMatchObject({
      code: 'archive_key_rejected',
    });

    const flipped = readFileSync(path);
    flipped[flipped.length - 40] = (flipped[flipped.length - 40] as number) ^ 0xff;
    writeFileSync(join(dir, 'flip.opsx'), flipped);
    await expect(collect(join(dir, 'flip.opsx'))).rejects.toBeInstanceOf(ExportError);
  });

  it('rejects a cut, an extended and a headerless archive', async () => {
    const path = join(dir, 'a.opsx');
    await write(path, { a: randomBytes(200_000) });
    const whole = readFileSync(path);
    writeFileSync(join(dir, 'cut.opsx'), whole.subarray(0, whole.length - 30));
    await expect(collect(join(dir, 'cut.opsx'))).rejects.toMatchObject({ code: 'archive_corrupt' });
    // Dropping the final chunk (a clean chunk boundary) is also detected.
    writeFileSync(join(dir, 'chunks.opsx'), whole.subarray(0, 24 + 5 + 65_552));
    await expect(collect(join(dir, 'chunks.opsx'))).rejects.toMatchObject({
      code: 'archive_corrupt',
    });
    writeFileSync(
      join(dir, 'ext.opsx'),
      Buffer.concat([whole, Buffer.from([1, 0, 0, 0, 16, ...randomBytes(16)])]),
    );
    await expect(collect(join(dir, 'ext.opsx'))).rejects.toMatchObject({ code: 'archive_corrupt' });
    writeFileSync(join(dir, 'junk.opsx'), randomBytes(100));
    await expect(collect(join(dir, 'junk.opsx'))).rejects.toMatchObject({
      code: 'archive_corrupt',
    });
    writeFileSync(join(dir, 'tiny.opsx'), Buffer.from('OPS'));
    await expect(collect(join(dir, 'tiny.opsx'))).rejects.toMatchObject({
      code: 'archive_corrupt',
    });
  });

  it('refuses to overwrite a file and unsafe entry names', async () => {
    const path = join(dir, 'a.opsx');
    await write(path, { a: Buffer.from('x') });
    await expect(ArchiveWriter.create(path, key)).rejects.toMatchObject({ code: 'output_exists' });
    const writer = await ArchiveWriter.create(join(dir, 'b.opsx'), key);
    for (const name of ['../x', '/abs', 'a//b', '', 'a b', '.hidden/x'])
      await expect(writer.add(name, [Buffer.from('x')])).rejects.toMatchObject({
        code: 'bad_arguments',
      });
    writer.abort();
  });

  it('derives a different sealed file for the same content (random salt)', async () => {
    const a = join(dir, 'a.opsx');
    const b = join(dir, 'b.opsx');
    expect(await write(a, { x: Buffer.from('same') })).not.toBe(
      await write(b, { x: Buffer.from('same') }),
    );
  });

  it('accepts only a base64 key of at least 32 bytes', () => {
    expect(parseArchiveKey(randomBytes(32).toString('base64')).length).toBe(32);
    expect(() => parseArchiveKey(undefined)).toThrow(ExportError);
    expect(() => parseArchiveKey(randomBytes(16).toString('base64'))).toThrow(ExportError);
  });
});
