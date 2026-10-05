export type Provider = 'codex' | 'claude';
export type Model = 'gpt-6-luna' | 'claude-sonnet-5-5' | 'claude-opus-5-5';
export type TaskStatus = 'planned' | 'ready' | 'leased' | 'blocked' | 'completed';
export type GateStatus = 'pending' | 'passed' | 'failed';
export interface Task {
  id: string;
  stage: number;
  status: TaskStatus;
  dependencies: string[];
  allowedPaths: string[];
  candidateSha?: string;
}
export interface Lease {
  taskId: string;
  owner: string;
  worktree: string;
  baseSha: string;
  requestedPaths: string[];
  fencing: number;
  provider: Provider;
  model: Model;
  epoch: number;
  expiresAt: number;
}
export interface Candidate {
  taskId: string;
  sha: string;
  auditProvider: Provider;
  auditSha: string;
  ciPassed: boolean;
  auditCount: 1;
  independentAudit: boolean;
  observedModel: Model;
  evidenceId: string;
}
/** Independent milestone audit of a gate candidate (ORCH-1.1 §2: two auditors per gate). */
export interface GateAudit {
  auditorId: string;
  candidateSha: string;
  provider: Provider;
  observedModel: Model;
  verdict: 'approve' | 'request_changes';
  evidenceId: string;
}
export interface RuntimeSnapshot {
  epoch: number;
  fencing: number;
  provider: Provider;
  model: Model;
  tasks: Task[];
  leases: Lease[];
  gates: Record<number, GateStatus>;
  eventIds: string[];
}
export const MODEL_BY_PROVIDER: Record<Provider, Model> = {
  codex: 'gpt-6-luna',
  claude: 'claude-sonnet-5-5',
};
export const AUDIT_MODEL_BY_PROVIDER: Record<Provider, Model> = {
  codex: 'gpt-6-luna',
  claude: 'claude-opus-5-5',
};
