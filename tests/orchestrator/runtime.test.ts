import { describe, expect, it } from 'vitest';
import { OrchestratorRuntime } from '../../tools/orchestrator/runtime.js';

const task = (id: string, stage = 0, dependencies: string[] = []) => ({
  id,
  stage,
  status: 'ready' as const,
  dependencies,
  allowedPaths: [`tools/${id}/**`],
});
const evidence = (taskId: string, sha: string) => ({
  taskId,
  sha,
  auditSha: sha,
  auditProvider: 'codex' as const,
  ciPassed: true,
  auditCount: 1 as const,
  independentAudit: true,
  observedModel: 'gpt-5.6-luna' as const,
  evidenceId: `audit-${taskId}`,
});

describe('orchestrator runtime', () => {
  it('assigns explicit lease/fencing and enforces allowed paths', () => {
    const runtime = new OrchestratorRuntime();
    runtime.register([task('a'), { ...task('b'), allowedPaths: ['tools/a/**'] }]);
    expect(() =>
      runtime.acquire('a', 'agent-a', 'C:/wt/a', 'base', 10, 100, ['packages/other/file.ts']),
    ).toThrow('path outside');
    const lease = runtime.acquire('a', 'agent-a', 'C:/wt/a', 'base', 10, 100, [
      'tools/a/src/index.ts',
    ]);
    expect(lease).toMatchObject({
      owner: 'agent-a',
      baseSha: 'base',
      model: 'gpt-5.6-luna',
      fencing: 1,
    });
    expect(() => runtime.acquire('a', 'agent-b', 'C:/wt/b', 'base', 10)).toThrow('already leased');
    expect(() =>
      runtime.acquire('b', 'agent-b', 'C:/wt/b', 'base', 10, 100, ['tools/a/src/index.ts']),
    ).toThrow('overlap');
    const planned = new OrchestratorRuntime();
    planned.register([{ ...task('planned'), status: 'planned' }]);
    expect(() => planned.acquire('planned', 'agent-p', 'C:/wt/p', 'base', 0)).toThrow('not ready');
  });
  it('reassigns expired leases with new fencing and separates base from candidate SHA', () => {
    const runtime = new OrchestratorRuntime();
    runtime.register([task('a')]);
    const first = runtime.acquire('a', 'agent-a', 'C:/wt/a', 'base', 10, 5);
    expect(() => runtime.complete('a', first.fencing, 'head', 15, 'event-1')).toThrow('expired');
    const second = runtime.acquire('a', 'agent-b', 'C:/wt/b', 'base', 16);
    expect(second.fencing).toBeGreaterThan(first.fencing);
    runtime.complete('a', second.fencing, 'head', 17, 'event-2');
    expect(runtime.validateCandidate(evidence('a', 'head'))).toBe(true);
  });
  it('is idempotent and rejects stale fencing', () => {
    const runtime = new OrchestratorRuntime();
    runtime.register([task('a')]);
    const lease = runtime.acquire('a', 'agent-a', 'C:/wt/a', 'base', 0);
    expect(() => runtime.complete('a', lease.fencing - 1, 'head', 1, 'event-1')).toThrow(
      'stale fencing',
    );
    runtime.complete('a', lease.fencing, 'head', 1, 'event-1');
    expect(() => runtime.complete('a', lease.fencing, 'head', 1, 'event-1')).not.toThrow();
  });
  it('blocks stages and requires exactly one independent audit before passing a gate', () => {
    const runtime = new OrchestratorRuntime();
    runtime.register([task('a', 0), task('b', 1, ['a'])]);
    expect(() => runtime.acquire('b', 'agent-b', 'C:/wt/b', 'base', 0)).toThrow('blocked');
    const lease = runtime.acquire('a', 'agent-a', 'C:/wt/a', 'base', 0);
    runtime.complete('a', lease.fencing, 'head-a', 1, 'event-a');
    expect(() => runtime.setGate(0, 'passed', [])).toThrow('lacks candidate evidence');
    runtime.setGate(0, 'passed', [evidence('a', 'head-a')]);
    const next = runtime.acquire('b', 'agent-b', 'C:/wt/b', 'base-b', 1);
    runtime.complete('b', next.fencing, 'head-b', 2, 'event-b');
    expect(() =>
      runtime.setGate(1, 'passed', [{ ...evidence('b', 'head-b'), auditCount: 1 }]),
    ).not.toThrow();
    expect(runtime.validateCandidate({ ...evidence('b', 'head-b'), auditSha: 'old' })).toBe(false);
  });
  it('persists fencing, events and provider epoch through restore', () => {
    const runtime = new OrchestratorRuntime();
    runtime.register([task('a')]);
    const lease = runtime.acquire('a', 'agent-a', 'C:/wt/a', 'base', 0);
    runtime.complete('a', lease.fencing, 'head', 1, 'event-a');
    runtime.handoff('claude');
    const restored = OrchestratorRuntime.restore(runtime.snapshot());
    expect(restored.snapshot()).toMatchObject({
      epoch: 2,
      fencing: 1,
      provider: 'claude',
      model: 'claude-sonnet-5',
      eventIds: ['event-a'],
    });
  });
});
