import React from 'react';
import type { BffEvidenceCategory, BffEvidenceStage } from '@opslog/contracts';
import { describeError, isStale } from './errors';
import type { IncidentPorts } from './ports';
import {
  canvasCompress,
  limitFor,
  prepareFile,
  toBase64,
  type Compressor,
  type Prepared,
} from './prepareFile';
import { SubmitKeys, sendKeyed } from './submit';

export interface QueueItem {
  readonly id: string;
  readonly name: string;
  readonly status: 'pending' | 'uploading' | 'error';
  readonly progress: number;
  /** Why it failed, or what the queue is doing now (waiting to retry). */
  readonly message?: string;
}

interface Job {
  readonly id: string;
  readonly file: File;
  readonly category: BffEvidenceCategory;
  readonly stage: BffEvidenceStage;
  readonly keys: SubmitKeys;
  /** The case version of an attempt whose outcome is unknown: a retry sends it again, so the key replays. */
  pendingVersion?: number;
  prepared?: Prepared;
  base64?: string;
}

/** Waits before each automatic retry after a lost connection; after the last one the person retries by hand. */
export const DEFAULT_RETRY_DELAYS: readonly number[] = [2000, 6000];

export interface UploadQueue {
  readonly items: readonly QueueItem[];
  add(
    files: readonly File[],
    meta: { category: BffEvidenceCategory; stage: BffEvidenceStage },
  ): void;
  retry(id: string): void;
  discardFailed(): void;
}

let counter = 0;

/**
 * Sends files one at a time (each upload moves the case's version, so they cannot overlap). A photo is
 * compressed first; a lost connection is retried by itself, with the same Idempotency-Key so the server never
 * stores a file twice; anything else stops at "error" with a clear reason and a button to retry. Files that
 * were accepted leave the queue: the saved list shows them with their own status.
 */
export function useUploadQueue({
  ports,
  incidentId,
  version,
  compress = canvasCompress,
  retryDelays = DEFAULT_RETRY_DELAYS,
  onUploaded,
  onStale,
  onExpired,
}: {
  ports: IncidentPorts;
  incidentId: string;
  version: number;
  compress?: Compressor;
  retryDelays?: readonly number[];
  onUploaded: (version: number) => void;
  onStale: () => void;
  onExpired: () => void;
}): UploadQueue {
  const [items, setItems] = React.useState<readonly QueueItem[]>([]);
  const jobs = React.useRef(new Map<string, Job>());
  const chain = React.useRef<Promise<void>>(Promise.resolve());
  const latest = React.useRef(version);
  latest.current = Math.max(latest.current, version);
  const alive = React.useRef(true);
  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const patch = (id: string, change: Partial<QueueItem>) => {
    if (alive.current)
      setItems((current) =>
        current.map((item) => (item.id === id ? { ...item, ...change } : item)),
      );
  };
  const fail = (id: string, message: string) =>
    patch(id, { status: 'error', progress: 0, message });
  const drop = (id: string) => {
    jobs.current.delete(id);
    if (alive.current) setItems((current) => current.filter((item) => item.id !== id));
  };

  async function run(job: Job): Promise<void> {
    patch(job.id, { status: 'uploading', progress: 15 });
    try {
      job.prepared ??= await prepareFile(job.file, compress);
      if (job.prepared.blob.size > limitFor(job.prepared.contentType))
        return fail(
          job.id,
          'El archivo supera el máximo: 15 MB para imágenes y 25 MB para PDF, DOCX y XLSX.',
        );
      job.base64 ??= await toBase64(job.prepared.blob);
    } catch {
      return fail(job.id, 'No pudimos leer el archivo. Elígelo de nuevo.');
    }
    const prepared = job.prepared;
    const contentBase64 = job.base64;
    for (let attempt = 0; ; attempt += 1) {
      // The same attempt keeps its version until the server answers for good: the server hashes the version
      // into the key, so a retry after a lost answer must repeat it to be recognised and not store a second copy.
      job.pendingVersion ??= latest.current;
      const body = {
        version: job.pendingVersion,
        category: job.category,
        stage: job.stage,
        ...(prepared.capturedAt === null ? {} : { capturedAt: prepared.capturedAt }),
        ...(prepared.clientCompressed ? { clientCompressed: true } : {}),
        name: prepared.name,
        contentType: prepared.contentType,
        contentBase64,
      };
      patch(job.id, { progress: 60 });
      // The content never changes for a job, so the file alone tells it from another upload (not the version).
      const result = await sendKeyed(job.keys, [job.id, body.name, contentBase64.length], (key) =>
        ports.evidence.upload(incidentId, body, key),
      );
      if (result.ok || result.error.status < 500) delete job.pendingVersion;
      if (result.ok) {
        latest.current = Math.max(latest.current, result.value.version);
        onUploaded(result.value.version);
        return drop(job.id);
      }
      const { error } = result;
      if (error.status === 401) onExpired();
      if (error.code === 'network_error' && attempt < retryDelays.length) {
        patch(job.id, { message: 'Sin conexión: reintentando…' });
        await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt]));
        continue;
      }
      if (isStale(error)) onStale();
      return fail(job.id, describeError(error, 'subir el archivo'));
    }
  }

  const enqueue = (job: Job) => {
    chain.current = chain.current.then(() => run(job));
  };
  return {
    items,
    add: (files, meta) => {
      const added: Job[] = files.map((file) => {
        counter += 1;
        return { id: `upload-${counter}`, file, ...meta, keys: new SubmitKeys() };
      });
      for (const job of added) jobs.current.set(job.id, job);
      setItems((current) => [
        ...current,
        ...added.map((job) => ({
          id: job.id,
          name: job.file.name,
          status: 'pending' as const,
          progress: 0,
        })),
      ]);
      for (const job of added) enqueue(job);
    },
    retry: (id) => {
      const job = jobs.current.get(id);
      if (!job) return;
      patch(id, { status: 'pending', progress: 0 });
      enqueue(job);
    },
    discardFailed: () => {
      for (const item of items) if (item.status === 'error') jobs.current.delete(item.id);
      setItems((current) => current.filter((item) => item.status !== 'error'));
    },
  };
}
