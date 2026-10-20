/**
 * A unit of work the worker loop runs on every tick (outbox, scans, audit relay, exports, ...).
 * A module adds its work by registering a job; the loop itself never changes.
 */
export interface WorkerJob {
  /** Stable name, lower-case words separated by `.` or `-`; it is the only thing reported on failure. */
  readonly name: string;
  run(): Promise<unknown>;
}

const NAME = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;

/** The ordered list of jobs a tick walks. Names are unique. */
export class JobRegistry {
  private readonly entries: WorkerJob[] = [];

  public register(job: WorkerJob): void {
    if (!NAME.test(job.name)) throw new Error(`invalid job name: ${job.name}`);
    if (this.entries.some((entry) => entry.name === job.name))
      throw new Error(`job already registered: ${job.name}`);
    this.entries.push(job);
  }

  /** Jobs in registration order. */
  public list(): readonly WorkerJob[] {
    return [...this.entries];
  }
}
