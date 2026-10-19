import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, type WriteStream } from 'node:fs';
import { once } from 'node:events';
import { Transform, type TransformCallback } from 'node:stream';
import { pipeline as pipelineStreams } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip, type Gzip } from 'node:zlib';
import { ExportError, type EntryDigest } from './types.js';

/**
 * The export container. Plain data is a sequence of entries (path + bytes) framed as
 * `[type:1][length:4][payload]`, gzip-compressed and then sealed in 64 KiB chunks with AES-256-GCM
 * under a key derived (HKDF-SHA-256, per-archive random salt) from the key the operator supplies.
 * Each chunk is authenticated with its position and a final flag, so a reordered, cut or extended
 * archive fails instead of reading as a smaller valid one. Nothing is written in clear: there is no
 * temporary plaintext file, entries stream through memory.
 *
 *   file := MAGIC(8) salt(16) { flag(1) length(4) ciphertext+tag }...   (the last chunk has flag 1)
 */
const MAGIC = Buffer.from('OPSXPRT1', 'latin1');
const SALT_BYTES = 16;
const HEADER_BYTES = MAGIC.length + SALT_BYTES;
const CHUNK = 64 * 1024;
const TAG = 16;
const INFO = 'opslog-tenant-export-v1';
const FRAME_START = 1;
const FRAME_DATA = 2;
const FRAME_END = 3;
const MAX_FRAME = 1 << 20;
const PATH = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/;

/** Parses the operator's key: base64 of at least 32 bytes. */
export function parseArchiveKey(value: string | undefined): Buffer {
  const key = value ? Buffer.from(value.trim(), 'base64') : Buffer.alloc(0);
  if (key.length < 32) throw new ExportError('missing_setting');
  return key;
}

const deriveKey = (key: Buffer, salt: Buffer): Buffer =>
  Buffer.from(hkdfSync('sha256', key, salt, INFO, 32));

function nonceOf(counter: number): Buffer {
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64BE(BigInt(counter), 4);
  return nonce;
}

const aadOf = (header: Buffer, counter: number, flag: number): Buffer => {
  const tail = Buffer.alloc(9);
  tail.writeBigUInt64BE(BigInt(counter), 0);
  tail.writeUInt8(flag, 8);
  return Buffer.concat([header, tail]);
};

/** Seals the byte stream in chunks; the header (magic + salt) is emitted first. */
class Sealer extends Transform {
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private counter = 0;
  private started = false;

  public constructor(
    private readonly key: Buffer,
    private readonly header: Buffer,
  ) {
    super();
  }

  private sealChunk(plain: Buffer, final: boolean): void {
    if (!this.started) {
      this.started = true;
      this.push(this.header);
    }
    const flag = final ? 1 : 0;
    const cipher = createCipheriv('aes-256-gcm', this.key, nonceOf(this.counter));
    cipher.setAAD(aadOf(this.header, this.counter, flag));
    const body = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
    const prefix = Buffer.alloc(5);
    prefix.writeUInt8(flag, 0);
    prefix.writeUInt32BE(body.length, 1);
    this.counter += 1;
    this.push(Buffer.concat([prefix, body]));
  }

  public override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    done: TransformCallback,
  ): void {
    this.pending.push(chunk);
    this.pendingBytes += chunk.length;
    if (this.pendingBytes >= CHUNK) {
      const all = Buffer.concat(this.pending);
      let offset = 0;
      while (all.length - offset >= CHUNK) {
        this.sealChunk(all.subarray(offset, offset + CHUNK), false);
        offset += CHUNK;
      }
      const rest = all.subarray(offset);
      this.pending = rest.length > 0 ? [rest] : [];
      this.pendingBytes = rest.length;
    }
    done();
  }

  public override _flush(done: TransformCallback): void {
    this.sealChunk(Buffer.concat(this.pending), true);
    done();
  }
}

/** Opens the sealed chunks of an archive and emits the plain bytes; throws `ExportError` on any flaw. */
class Opener extends Transform {
  private buffer = Buffer.alloc(0);
  private header: Buffer | undefined;
  private key: Buffer | undefined;
  private counter = 0;
  private sawFinal = false;

  public constructor(private readonly operatorKey: Buffer) {
    super();
  }

  private fail(code: 'archive_corrupt' | 'archive_key_rejected'): never {
    throw new ExportError(code);
  }

  public override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    done: TransformCallback,
  ): void {
    try {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      if (!this.header) {
        if (this.buffer.length < HEADER_BYTES) return done();
        const header = this.buffer.subarray(0, HEADER_BYTES);
        if (!header.subarray(0, MAGIC.length).equals(MAGIC)) this.fail('archive_corrupt');
        this.header = Buffer.from(header);
        this.key = deriveKey(this.operatorKey, header.subarray(MAGIC.length));
        this.buffer = this.buffer.subarray(HEADER_BYTES);
      }
      while (this.buffer.length >= 5) {
        const flag = this.buffer.readUInt8(0);
        const length = this.buffer.readUInt32BE(1);
        if (flag > 1 || length < TAG || length > CHUNK + TAG) this.fail('archive_corrupt');
        if (this.buffer.length < 5 + length) break;
        if (this.sawFinal) this.fail('archive_corrupt');
        const body = this.buffer.subarray(5, 5 + length);
        this.buffer = this.buffer.subarray(5 + length);
        const decipher = createDecipheriv('aes-256-gcm', this.key as Buffer, nonceOf(this.counter));
        decipher.setAAD(aadOf(this.header, this.counter, flag));
        decipher.setAuthTag(body.subarray(body.length - TAG));
        let plain: Buffer;
        try {
          plain = Buffer.concat([
            decipher.update(body.subarray(0, body.length - TAG)),
            decipher.final(),
          ]);
        } catch {
          // The first chunk failing means the key (or the header) is wrong; later ones, a damaged file.
          return done(
            new ExportError(this.counter === 0 ? 'archive_key_rejected' : 'archive_corrupt'),
          );
        }
        this.counter += 1;
        if (flag === 1) this.sawFinal = true;
        if (plain.length > 0) this.push(plain);
      }
      done();
    } catch (error) {
      done(error instanceof ExportError ? error : new ExportError('archive_corrupt'));
    }
  }

  public override _flush(done: TransformCallback): void {
    done(this.sawFinal && this.buffer.length === 0 ? null : new ExportError('archive_corrupt'));
  }
}

export interface ArchiveSummary {
  readonly bytes: number;
  readonly sha256: string;
}

/** Streams entries into one sealed archive file. Create with `ArchiveWriter.create`. */
export class ArchiveWriter {
  private constructor(
    private readonly gzip: Gzip,
    private readonly done: Promise<void>,
    private readonly file: WriteStream,
    private readonly hash: ReturnType<typeof createHash>,
  ) {}

  /** Creates `path` (it must not exist, owner-only). */
  public static async create(path: string, operatorKey: Buffer): Promise<ArchiveWriter> {
    const salt = randomBytes(SALT_BYTES);
    const header = Buffer.concat([MAGIC, salt]);
    const file = createWriteStream(path, { flags: 'wx', mode: 0o600 });
    const hash = createHash('sha256');
    const gzip = createGzip({ level: 6 });
    const sealer = new Sealer(deriveKey(operatorKey, salt), header);
    sealer.on('data', (chunk: Buffer) => hash.update(chunk));
    const done = pipeline(gzip, sealer, file);
    done.catch(() => undefined);
    try {
      await once(file, 'open');
    } catch {
      throw new ExportError('output_exists');
    }
    return new ArchiveWriter(gzip, done, file, hash);
  }

  private async frame(type: number, payload: Buffer): Promise<void> {
    const head = Buffer.alloc(5);
    head.writeUInt8(type, 0);
    head.writeUInt32BE(payload.length, 1);
    if (!this.gzip.write(Buffer.concat([head, payload]))) await once(this.gzip, 'drain');
  }

  /** Adds one entry from a sequence of chunks; returns its size and SHA-256. */
  public async add(
    path: string,
    chunks: AsyncIterable<Uint8Array | string> | Iterable<Uint8Array | string>,
  ): Promise<EntryDigest> {
    if (!PATH.test(path) || path.length > 200) throw new ExportError('bad_arguments');
    await this.frame(FRAME_START, Buffer.from(path, 'utf8'));
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const piece of chunks) {
      const data = typeof piece === 'string' ? Buffer.from(piece, 'utf8') : Buffer.from(piece);
      for (let offset = 0; offset < data.length; offset += MAX_FRAME) {
        const part = data.subarray(offset, offset + MAX_FRAME);
        hash.update(part);
        bytes += part.length;
        await this.frame(FRAME_DATA, part);
      }
    }
    await this.frame(FRAME_END, Buffer.alloc(0));
    return { path, bytes, sha256: hash.digest('hex') };
  }

  /** Finishes the file and returns the size and SHA-256 of the sealed archive. */
  public async finish(): Promise<ArchiveSummary> {
    this.gzip.end();
    await this.done;
    return { bytes: this.file.bytesWritten, sha256: this.hash.digest('hex') };
  }

  /** Closes a half-written archive after a failure; the caller deletes the file. */
  public abort(): void {
    this.gzip.destroy();
    this.file.destroy();
  }
}

export type ArchiveEvent =
  | { readonly type: 'start'; readonly path: string }
  | { readonly type: 'data'; readonly chunk: Buffer }
  | { readonly type: 'end' };

/** Reads an archive entry by entry. Throws `ExportError` for a wrong key, a damaged or a cut file. */
export async function* readArchive(
  path: string,
  operatorKey: Buffer,
): AsyncGenerator<ArchiveEvent> {
  // `pipeline` destroys the last stage with the first error, so the loop below rethrows it.
  const gunzip = pipelineStreams(
    createReadStream(path),
    new Opener(operatorKey),
    createGunzip(),
    () => undefined,
  );
  let buffer = Buffer.alloc(0);
  let open = false;
  try {
    for await (const chunk of gunzip as AsyncIterable<Buffer>) {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 5) {
        const type = buffer.readUInt8(0);
        const length = buffer.readUInt32BE(1);
        if (length > MAX_FRAME) throw new ExportError('archive_corrupt');
        if (buffer.length < 5 + length) break;
        const payload = buffer.subarray(5, 5 + length);
        buffer = buffer.subarray(5 + length);
        if (type === FRAME_START) {
          const name = payload.toString('utf8');
          if (open || !PATH.test(name)) throw new ExportError('archive_corrupt');
          open = true;
          yield { type: 'start', path: name };
        } else if (type === FRAME_DATA && open) yield { type: 'data', chunk: Buffer.from(payload) };
        else if (type === FRAME_END && open) {
          open = false;
          yield { type: 'end' };
        } else throw new ExportError('archive_corrupt');
      }
    }
  } catch (error) {
    throw error instanceof ExportError ? error : new ExportError('archive_corrupt');
  }
  if (open || buffer.length > 0) throw new ExportError('archive_corrupt');
}
