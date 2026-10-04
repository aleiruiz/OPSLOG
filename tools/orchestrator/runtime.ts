import {
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
      this.tasks.set(task.id, { ...task, dependencies: [...task.dependencies] });
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
  ): Lease {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`unknown task ${taskId}`);
    if (task.status === 'completed') throw new Error(`task ${taskId} is completed`);
    if (this.leases.has(taskId)) throw new Error(`task ${taskId} already leased`);
    if (task.stage > 0 && this.gates.get(task.stage - 1) !== 'passed')
      throw new Error(`stage ${task.stage} is blocked by gate ${task.stage - 1}`);
    for (const dependency of task.dependencies)
      if (this.tasks.get(dependency)?.status !== 'completed')
        throw new Error(`dependency ${dependency} is not completed`);
    const lease: Lease = {
      taskId,
      owner,
      worktree,
      baseSha,
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
  public complete(taskId: string, fencing: number, sha: string, now: number): void {
    const task = this.tasks.get(taskId);
    const lease = this.leases.get(taskId);
    if (!task || !lease) throw new Error('no active lease');
    if (lease.fencing !== fencing || lease.epoch !== this.epoch)
      throw new Error('stale fencing token');
    if (lease.expiresAt <= now) throw new Error('lease expired');
    if (sha !== lease.baseSha) throw new Error('candidate base SHA changed');
    task.status = 'completed';
    this.leases.delete(taskId);
  }
  public validateCandidate(candidate: Candidate): boolean {
    const task = this.tasks.get(candidate.taskId);
    return Boolean(
      task?.status === 'completed' &&
        candidate.sha === candidate.auditSha &&
        candidate.auditProvider === this.provider &&
        candidate.ciPassed,
    );
  }
  public setGate(stage: number, status: GateStatus): void {
    if (
      status === 'passed' &&
      [...this.leases.values()].some((lease) => this.tasks.get(lease.taskId)?.stage === stage)
    )
      throw new Error(`cannot pass gate ${stage} with active leases`);
    this.gates.set(stage, status);
  }
  public snapshot(): RuntimeSnapshot {
    return {
      epoch: this.epoch,
      provider: this.provider,
      model: this.model,
      tasks: [...this.tasks.values()].map((task) => ({
        ...task,
        dependencies: [...task.dependencies],
      })),
      leases: [...this.leases.values()].map((lease) => ({ ...lease })),
      gates: Object.fromEntries(this.gates),
    };
  }
  public static restore(snapshot: RuntimeSnapshot): OrchestratorRuntime {
    const runtime = new OrchestratorRuntime(snapshot.provider, snapshot.model);
    runtime.epoch = snapshot.epoch;
    runtime.register(snapshot.tasks);
    runtime.leases.clear();
    for (const lease of snapshot.leases) runtime.leases.set(lease.taskId, { ...lease });
    for (const [stage, status] of Object.entries(snapshot.gates))
      runtime.gates.set(Number(stage), status);
    runtime.fencing = Math.max(0, ...snapshot.leases.map((lease) => lease.fencing));
    return runtime;
  }
}
