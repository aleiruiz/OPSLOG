import {
  AUDIT_MODEL_BY_PROVIDER,
  Candidate,
  GateStatus,
  Lease,
  MODEL_BY_PROVIDER,
  Model,
  Provider,
  RuntimeSnapshot,
  Task,
} from './domain.js';

export class OrchestratorRuntime {
  private readonly tasks = new Map<string, Task>();
  private readonly leases = new Map<string, Lease>();
  private readonly gates = new Map<number, GateStatus>();
  private readonly eventIds = new Set<string>();
  private epoch = 1;
  private fencing = 0;

  public constructor(
    private provider: Provider = 'codex',
    private model: Model = MODEL_BY_PROVIDER[provider],
  ) {
    if (model !== MODEL_BY_PROVIDER[provider])
      throw new Error(`model ${model} is not valid for provider ${provider}`);
  }
  public register(tasks: Task[]): void {
    for (const task of tasks) {
      if (this.tasks.has(task.id)) throw new Error(`duplicate task ${task.id}`);
      this.tasks.set(task.id, {
        ...task,
        dependencies: [...task.dependencies],
        allowedPaths: [...task.allowedPaths],
      });
      if (!this.gates.has(task.stage)) this.gates.set(task.stage, 'pending');
    }
  }
  public handoff(provider: Provider): void {
    if (this.leases.size > 0) throw new Error('cannot handoff while leases are active');
    this.provider = provider;
    this.model = MODEL_BY_PROVIDER[provider];
    this.epoch += 1;
  }
  public acquire(
    taskId: string,
    owner: string,
    worktree: string,
    baseSha: string,
    now: number,
    ttlMs = 300_000,
    requestedPaths?: string[],
  ): Lease {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`unknown task ${taskId}`);
    const activeLease = this.leases.get(taskId);
    if (activeLease && activeLease.expiresAt > now)
      throw new Error(`task ${taskId} already leased`);
    if (activeLease) {
      this.leases.delete(taskId);
      task.status = 'ready';
    }
    if (task.status !== 'ready') throw new Error(`task ${taskId} is not ready`);
    if (task.stage > 0 && this.gates.get(task.stage - 1) !== 'passed')
      throw new Error(`stage ${task.stage} is blocked by gate ${task.stage - 1}`);
    for (const dependency of task.dependencies)
      if (this.tasks.get(dependency)?.status !== 'completed')
        throw new Error(`dependency ${dependency} is not completed`);
    const paths = requestedPaths ?? task.allowedPaths;
    if (paths.some((path) => !task.allowedPaths.some((allowed) => this.pathMatches(allowed, path))))
      throw new Error(`path outside task scope ${taskId}`);
    if (
      [...this.leases.values()].some((lease) =>
        lease.requestedPaths.some((heldPath) =>
          paths.some((path) => this.pathsOverlap(heldPath, path)),
        ),
      )
    )
      throw new Error('requested paths overlap an active lease');
    const lease: Lease = {
      taskId,
      owner,
      worktree,
      baseSha,
      requestedPaths: [...paths],
      fencing: ++this.fencing,
      provider: this.provider,
      model: this.model,
      epoch: this.epoch,
      expiresAt: now + ttlMs,
    };
    this.leases.set(taskId, lease);
    task.status = 'leased';
    return { ...lease };
  }
  public renew(taskId: string, fencing: number, now: number, ttlMs = 300_000): Lease {
    const lease = this.leases.get(taskId);
    if (!lease || lease.fencing !== fencing || lease.epoch !== this.epoch)
      throw new Error('stale fencing token');
    if (lease.expiresAt <= now) throw new Error('lease expired');
    lease.expiresAt = now + ttlMs;
    return { ...lease };
  }
  public complete(
    taskId: string,
    fencing: number,
    candidateSha: string,
    now: number,
    eventId: string,
  ): void {
    if (this.eventIds.has(eventId)) return;
    const task = this.tasks.get(taskId);
    const lease = this.leases.get(taskId);
    if (!task || !lease) throw new Error('no active lease');
    if (lease.fencing !== fencing || lease.epoch !== this.epoch)
      throw new Error('stale fencing token');
    if (lease.expiresAt <= now) throw new Error('lease expired');
    if (!candidateSha) throw new Error('candidate SHA is required');
    this.eventIds.add(eventId);
    task.candidateSha = candidateSha;
    task.status = 'completed';
    this.leases.delete(taskId);
  }
  public validateCandidate(candidate: Candidate): boolean {
    const task = this.tasks.get(candidate.taskId);
    return Boolean(
      task?.status === 'completed' &&
        task.candidateSha === candidate.sha &&
        candidate.sha === candidate.auditSha &&
        candidate.auditProvider === this.provider &&
        candidate.ciPassed &&
        candidate.auditCount === 1 &&
        candidate.independentAudit &&
        candidate.observedModel === AUDIT_MODEL_BY_PROVIDER[this.provider] &&
        candidate.evidenceId.length > 0,
    );
  }
  public setGate(stage: number, status: GateStatus, candidates: Candidate[] = []): void {
    if (status === 'passed') {
      if (stage > 0 && this.gates.get(stage - 1) !== 'passed')
        throw new Error(`gate ${stage - 1} must pass before gate ${stage}`);
      if ([...this.leases.values()].some((lease) => this.tasks.get(lease.taskId)?.stage === stage))
        throw new Error(`cannot pass gate ${stage} with active leases`);
      const stageTasks = [...this.tasks.values()].filter((task) => task.stage === stage);
      if (stageTasks.some((task) => task.status !== 'completed'))
        throw new Error(`stage ${stage} is incomplete`);
      if (
        stageTasks.some(
          (task) =>
            !candidates.some(
              (candidate) => candidate.taskId === task.id && this.validateCandidate(candidate),
            ),
        )
      )
        throw new Error(`stage ${stage} lacks candidate evidence`);
    }
    this.gates.set(stage, status);
  }
  public snapshot(): RuntimeSnapshot {
    return {
      epoch: this.epoch,
      fencing: this.fencing,
      provider: this.provider,
      model: this.model,
      tasks: [...this.tasks.values()].map((task) => ({
        ...task,
        dependencies: [...task.dependencies],
        allowedPaths: [...task.allowedPaths],
      })),
      leases: [...this.leases.values()].map((lease) => ({
        ...lease,
        requestedPaths: [...lease.requestedPaths],
      })),
      gates: Object.fromEntries(this.gates),
      eventIds: [...this.eventIds],
    };
  }
  public static restore(snapshot: RuntimeSnapshot): OrchestratorRuntime {
    const runtime = new OrchestratorRuntime(snapshot.provider, snapshot.model);
    runtime.epoch = snapshot.epoch;
    runtime.fencing = snapshot.fencing;
    runtime.register(snapshot.tasks);
    runtime.leases.clear();
    for (const lease of snapshot.leases)
      runtime.leases.set(lease.taskId, { ...lease, requestedPaths: [...lease.requestedPaths] });
    for (const [stage, status] of Object.entries(snapshot.gates))
      runtime.gates.set(Number(stage), status);
    for (const eventId of snapshot.eventIds) runtime.eventIds.add(eventId);
    return runtime;
  }
  private pathMatches(allowed: string, actual: string): boolean {
    const allowedPath = this.canonicalPath(allowed);
    const actualPath = this.canonicalPath(actual);
    if (!allowedPath || !actualPath) return false;

    const prefix = allowedPath.endsWith('/**') ? allowedPath.slice(0, -3) : allowedPath;
    return actualPath === prefix || actualPath.startsWith(`${prefix}/`);
  }
  private pathsOverlap(left: string, right: string): boolean {
    const leftPath = this.canonicalPath(left);
    const rightPath = this.canonicalPath(right);
    if (!leftPath || !rightPath) return false;

    const leftPrefix = leftPath.endsWith('/**') ? leftPath.slice(0, -3) : leftPath;
    const rightPrefix = rightPath.endsWith('/**') ? rightPath.slice(0, -3) : rightPath;
    return (
      leftPrefix === rightPrefix ||
      leftPrefix.startsWith(`${rightPrefix}/`) ||
      rightPrefix.startsWith(`${leftPrefix}/`)
    );
  }
  private canonicalPath(path: string): string | undefined {
    const normalized = path.replaceAll('\\', '/');
    if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) return undefined;
    const segments = normalized.split('/');
    if (segments.some((segment) => segment === '.' || segment === '..')) return undefined;
    const compact = segments.filter((segment) => segment.length > 0);
    if (compact.length === 0) return undefined;
    return compact.join('/');
  }
}
