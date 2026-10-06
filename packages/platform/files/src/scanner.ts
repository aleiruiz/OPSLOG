export type ScanVerdict = { readonly outcome: 'clean' } | { readonly outcome: 'infected' };

/** Antivirus port. It must throw when the scanner is unreachable; it must never answer clean on failure. */
export interface VirusScanner {
  scan(
    input: { tenantId: string; fileId: string; contentType: string },
    bytes: Uint8Array,
  ): Promise<ScanVerdict>;
}

export const SYNTHETIC_MALWARE_MARKER = 'SYNTHETIC-TEST-MALWARE-MARKER';

/** Synthetic scanner: flags a marker string, or throws while `down`. Not a real antivirus. */
export class FakeScanner implements VirusScanner {
  public down = false;
  public calls = 0;
  public async scan(
    _input: { tenantId: string; fileId: string; contentType: string },
    bytes: Uint8Array,
  ): Promise<ScanVerdict> {
    this.calls += 1;
    if (this.down) throw new Error('scanner unavailable');
    const text = Buffer.from(bytes).toString('latin1');
    return text.includes(SYNTHETIC_MALWARE_MARKER) ? { outcome: 'infected' } : { outcome: 'clean' };
  }
}

export interface ScanJob {
  readonly tenantId: string;
  readonly fileId: string;
  readonly attempts: number;
  readonly nextAttemptAt: number;
}

/** Durable adapters must keep (tenantId, fileId) unique and make claims atomic. */
export interface ScanQueue {
  enqueue(tenantId: string, fileId: string, at: number): Promise<void>;
  /** Atomically claims due jobs for `leaseMs`; a claimed job is invisible to other claimers until it expires. */
  claimDue(now: number, leaseMs: number, limit: number): Promise<readonly ScanJob[]>;
  complete(tenantId: string, fileId: string): Promise<void>;
  /** Returns the claimed job to the queue for a later attempt. */
  defer(tenantId: string, fileId: string, nextAttemptAt: number): Promise<void>;
}

const jobKey = (tenantId: string, fileId: string): string =>
  `${tenantId.length}:${tenantId}${fileId.length}:${fileId}`;

export class InMemoryScanQueue implements ScanQueue {
  private readonly jobs = new Map<string, { job: ScanJob; claimedUntil: number }>();
  public async enqueue(tenantId: string, fileId: string, at: number): Promise<void> {
    const key = jobKey(tenantId, fileId);
    if (!this.jobs.has(key))
      this.jobs.set(key, {
        job: { tenantId, fileId, attempts: 0, nextAttemptAt: at },
        claimedUntil: 0,
      });
  }
  public async claimDue(now: number, leaseMs: number, limit: number): Promise<readonly ScanJob[]> {
    const claimed: ScanJob[] = [];
    for (const entry of this.jobs.values()) {
      if (claimed.length >= limit) break;
      if (entry.job.nextAttemptAt > now || entry.claimedUntil > now) continue;
      entry.claimedUntil = now + leaseMs;
      entry.job = { ...entry.job, attempts: entry.job.attempts + 1 };
      claimed.push({ ...entry.job });
    }
    return claimed;
  }
  public async complete(tenantId: string, fileId: string): Promise<void> {
    this.jobs.delete(jobKey(tenantId, fileId));
  }
  public async defer(tenantId: string, fileId: string, nextAttemptAt: number): Promise<void> {
    const entry = this.jobs.get(jobKey(tenantId, fileId));
    if (!entry) return;
    entry.claimedUntil = 0;
    entry.job = { ...entry.job, nextAttemptAt };
  }
  public size(): number {
    return this.jobs.size;
  }
}
