import { describe, expect, it } from 'vitest';
import { OrchestratorRuntime } from '../../tools/orchestrator/runtime.js';

const task = (id: string, stage = 0, dependencies: string[] = []) => ({
  id,
  stage,
  status: 'ready' as const,
  dependencies,
  allowedPaths: [`tools/${id}/**`],
});
describe('orchestrator runtime', () => {
  it('assigns explicit lease and fencing', () => {
    const runtime = new OrchestratorRuntime();
    runtime.register([task('a'), task('b'), task('c')]);
    const lease = runtime.acquire('a', 'agent-a', 'C:/wt/a', 'abc', 10);
    expect(lease).toMatchObject({
      owner: 'agent-a',
      baseSha: 'abc',
      model: 'gpt-5.6-luna',
      fencing: 1,
    });
    expect(() => runtime.acquire('a', 'agent-b', 'C:/wt/b', 'abc', 10)).toThrow('already leased');
  });
  it('rejects stale fencing, changed SHA and expired leases', () => {
    const runtime = new OrchestratorRuntime();
    runtime.register([task('a')]);
    const lease = runtime.acquire('a', 'agent-a', 'C:/wt/a', 'abc', 10, 5);
    expect(() => runtime.complete('a', lease.fencing - 1, 'abc', 11)).toThrow('stale fencing');
    expect(() => runtime.complete('a', lease.fencing, 'def', 11)).toThrow('candidate base SHA');
    expect(() => runtime.complete('a', lease.fencing, 'abc', 15)).toThrow('expired');
  });
  it('blocks later stages and requires one audit on the candidate SHA', () => {
    const runtime = new OrchestratorRuntime();
    runtime.register([task('a', 0), task('b', 1, ['a'])]);
    expect(() => runtime.acquire('b', 'agent-b', 'C:/wt/b', 'abc', 0)).toThrow('blocked');
    const lease = runtime.acquire('a', 'agent-a', 'C:/wt/a', 'abc', 0);
    runtime.complete('a', lease.fencing, 'abc', 1);
    runtime.setGate(0, 'passed');
    const next = runtime.acquire('b', 'agent-b', 'C:/wt/b', 'def', 1);
    runtime.complete('b', next.fencing, 'def', 2);
    expect(
      runtime.validateCandidate({
        taskId: 'b',
        sha: 'def',
        auditSha: 'def',
        auditProvider: 'codex',
        ciPassed: true,
      }),
    ).toBe(true);
    expect(
      runtime.validateCandidate({
        taskId: 'b',
        sha: 'def',
        auditSha: 'old',
        auditProvider: 'codex',
        ciPassed: true,
      }),
    ).toBe(false);
  });
  it('increments provider epoch and restores synthetic state', () => {
    const runtime = new OrchestratorRuntime();
    runtime.register([task('a')]);
    runtime.handoff('claude');
    expect(runtime.snapshot()).toMatchObject({
      epoch: 2,
      provider: 'claude',
      model: 'claude-sonnet-5',
    });
    expect(OrchestratorRuntime.restore(runtime.snapshot()).snapshot()).toMatchObject({
      epoch: 2,
      provider: 'claude',
      model: 'claude-sonnet-5',
    });
  });
});
