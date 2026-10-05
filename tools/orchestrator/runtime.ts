import {
  AUDIT_MODEL_BY_PROVIDER,
  Candidate,
  GateAudit,
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
      if (this.gates.get(task.stage) === 'passed') this.invalidateFrom(task.stage);
      else if (!this.gates.has(task.stage)) this.gates.set(task.stage, 'pending');
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
    for (let stage = 0; stage < task.stage; stage += 1)
      if (this.gates.has(stage) && this.gates.get(stage) !== 'passed')
        throw new Error(`stage ${task.stage} is blocked by gate ${stage}`);
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
    for (let stage = 0; stage < task.stage; stage += 1)
      if (this.gates.has(stage) && this.gates.get(stage) !== 'passed')
        throw new Error(`stage ${task.stage} is blocked by gate ${stage}`);
    this.eventIds.add(eventId);
    task.candidateSha = candidateSha;
    task.author = lease.owner;
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
  public setGate(
    stage: number,
    status: GateStatus,
    candidates: Candidate[] = [],
    audits: GateAudit[] = [],
  ): void {
    if (status === 'passed') {
      for (let earlier = 0; earlier < stage; earlier += 1)
        if (this.gates.has(earlier) && this.gates.get(earlier) !== 'passed')
          throw new Error(`gate ${earlier} must pass before gate ${stage}`);
      if ([...this.leases.values()].some((lease) => this.tasks.get(lease.taskId)?.stage === stage))
        throw new Error(`cannot pass gate ${stage} with active leases`);
      const stageTasks = [...this.tasks.values()].filter((task) => task.stage === stage);
      if (stageTasks.length === 0) throw new Error(`stage ${stage} has no tasks`);
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
      this.requireGateAudits(stageTasks, audits);
    } else {
      this.invalidateFrom(stage + 1);
    }
    this.gates.set(stage, status);
  }
  /**
   * ORCH-1.1 §2: a gate needs two independent approving auditors who all reviewed the same
   * cumulative candidate SHA, and none of them may be an author of a task in the stage.
   */
  private requireGateAudits(stageTasks: Task[], audits: GateAudit[]): void {
    if (audits.some((audit) => audit.verdict !== 'approve'))
      throw new Error('a gate auditor requested changes');
    const authors = new Set(stageTasks.map((task) => task.author));
    const valid = audits.filter(
      (audit) =>
        audit.provider === this.provider &&
        audit.observedModel === AUDIT_MODEL_BY_PROVIDER[this.provider] &&
        audit.evidenceId.length > 0 &&
        audit.auditorId.length > 0 &&
        audit.candidateSha.length > 0 &&
        !authors.has(audit.auditorId),
    );
    const bySha = new Map<string, Set<string>>();
    for (const audit of valid)
      bySha.set(
        audit.candidateSha,
        (bySha.get(audit.candidateSha) ?? new Set()).add(audit.auditorId),
      );
    if (new Set(audits.map((audit) => audit.candidateSha)).size > 1)
      throw new Error('gate audits must review the same candidate SHA');
    if (![...bySha.values()].some((auditors) => auditors.size >= 2))
      throw new Error('a gate needs two independent approving auditors');
  }
  /**
   * A gate that fails or reopens invalidates every later gate (gates are cumulative). Leases already
   * granted in later stages survive but cannot complete until the earlier gate passes again.
   */
  private invalidateFrom(stage: number): void {
    for (const [known, status] of this.gates)
      if (known >= stage && status === 'passed') this.gates.set(known, 'pending');
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
    for (const lease of snapshot.leases) {
      const leased = runtime.tasks.get(lease.taskId);
      if (!leased || leased.status !== 'leased' || lease.epoch !== snapshot.epoch)
        throw new Error(`snapshot lease for ${lease.taskId} is inconsistent`);
    }
    for (const lease of snapshot.leases)
      runtime.leases.set(lease.taskId, { ...lease, requestedPaths: [...lease.requestedPaths] });
    for (const [stage, status] of Object.entries(snapshot.gates)) {
      const number = Number(stage);
      if (status === 'passed') {
        const stageTasks = snapshot.tasks.filter((task) => task.stage === number);
        if (
          stageTasks.length === 0 ||
          stageTasks.some((task) => task.status !== 'completed' || !task.candidateSha)
        )
          throw new Error(`snapshot gate ${stage} passed without completed tasks`);
        for (let earlier = 0; earlier < number; earlier += 1)
          if (earlier in snapshot.gates && snapshot.gates[earlier] !== 'passed')
            throw new Error(`snapshot gate ${stage} passed before gate ${earlier}`);
      }
      runtime.gates.set(number, status);
    }
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
