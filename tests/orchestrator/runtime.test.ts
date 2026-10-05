import { describe, expect, it } from 'vitest';
import type { GateAudit, Model } from '../../tools/orchestrator/domain.js';
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
  observedModel: 'gpt-6-luna' as const,
  evidenceId: `audit-${taskId}`,
});

const audits = (sha: string, count = 2): GateAudit[] =>
  Array.from({ length: count }, (_, index) => ({
    auditorId: `auditor-${index + 1}`,
    candidateSha: sha,
    provider: 'codex' as const,
    observedModel: 'gpt-6-luna' as const,
    verdict: 'approve' as const,
    evidenceId: `gate-audit-${sha}-${index + 1}`,
  }));

describe('orchestrator runtime', () => {
  it('assigns explicit lease/fencing and enforces allowed paths', () => {
    const runtime = new OrchestratorRuntime();
    runtime.register([task('a'), { ...task('b'), allowedPaths: ['tools/a/**'] }]);
    expect(() =>
      runtime.acquire('a', 'agent-a', 'C:/wt/a', 'base', 10, 100, ['packages/other/file.ts']),
    ).toThrow('path outside');
    expect(() =>
      runtime.acquire('a', 'agent-a', 'C:/wt/a', 'base', 10, 100, ['tools/a/../b.ts']),
    ).toThrow('path outside');
    const lease = runtime.acquire('a', 'agent-a', 'C:/wt/a', 'base', 10, 100, [
      'tools/a/src/index.ts',
    ]);
    expect(lease).toMatchObject({
      owner: 'agent-a',
      baseSha: 'base',
      model: 'gpt-6-luna',
      fencing: 1,
    });
    expect(() => runtime.acquire('a', 'agent-b', 'C:/wt/b', 'base', 10)).toThrow('already leased');
    expect(() =>
      runtime.acquire('b', 'agent-b', 'C:/wt/b', 'base', 10, 100, ['tools/a/src/index.ts']),
    ).toThrow('overlap');
    const nested = new OrchestratorRuntime();
    nested.register([
      { ...task('a'), allowedPaths: ['tools/a/**'] },
      { ...task('b'), allowedPaths: ['tools/a/sub/**'] },
    ]);
    nested.acquire('a', 'agent-a', 'C:/wt/a', 'base', 10);
    expect(() => nested.acquire('b', 'agent-b', 'C:/wt/b', 'base', 10)).toThrow('overlap');
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
    runtime.setGate(0, 'passed', [evidence('a', 'head-a')], audits('head-a'));
    const next = runtime.acquire('b', 'agent-b', 'C:/wt/b', 'base-b', 1);
    runtime.complete('b', next.fencing, 'head-b', 2, 'event-b');
    expect(() =>
      runtime.setGate(
        1,
        'passed',
        [{ ...evidence('b', 'head-b'), auditCount: 1 }],
        audits('head-b'),
      ),
    ).not.toThrow();
    expect(runtime.validateCandidate({ ...evidence('b', 'head-b'), auditSha: 'old' })).toBe(false);
  });
  it('does not let a later gate pass before the previous gate passed', () => {
    const runtime = new OrchestratorRuntime();
    runtime.register([task('a', 0), task('b', 1)]);
    expect(() => runtime.setGate(1, 'passed', [])).toThrow('must pass before');
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
      model: 'claude-sonnet-5-5',
      eventIds: ['event-a'],
    });
  });

  it('accepts the Codex Luna 6 pin and rejects Luna 5.6, model mismatches and inactive-provider audits', () => {
    const runtime = new OrchestratorRuntime();
    runtime.register([task('a')]);
    const lease = runtime.acquire('a', 'agent-a', 'C:/wt/a', 'base', 0);
    expect(lease.model).toBe('gpt-6-luna');
    runtime.complete('a', lease.fencing, 'head', 1, 'event-a');

    expect(runtime.validateCandidate(evidence('a', 'head'))).toBe(true);
    expect(
      runtime.validateCandidate({
        ...evidence('a', 'head'),
        observedModel: 'gpt-5.6-luna' as Model,
      }),
    ).toBe(false);
    expect(
      runtime.validateCandidate({
        ...evidence('a', 'head'),
        auditProvider: 'claude',
        observedModel: 'claude-opus-5-5',
      }),
    ).toBe(false);
    expect(() => new OrchestratorRuntime('codex', 'gpt-5.6-luna' as Model)).toThrow(
      'not valid for provider codex',
    );
  });

  it('pins Claude authors to Sonnet 5.5 and requires an Opus 5.5 audit of the exact SHA', () => {
    const runtime = new OrchestratorRuntime('claude');
    runtime.register([task('a')]);
    const lease = runtime.acquire('a', 'agent-a', 'C:/wt/a', 'base', 0);
    expect(lease.model).toBe('claude-sonnet-5-5');
    runtime.complete('a', lease.fencing, 'head', 1, 'event-a');

    const audit = {
      ...evidence('a', 'head'),
      auditProvider: 'claude' as const,
      observedModel: 'claude-opus-5-5' as const,
    };
    expect(runtime.validateCandidate(audit)).toBe(true);
    expect(runtime.validateCandidate({ ...audit, observedModel: 'claude-sonnet-5-5' })).toBe(false);
    expect(runtime.validateCandidate({ ...audit, observedModel: 'claude-sonnet-5' as Model })).toBe(
      false,
    );
    expect(runtime.validateCandidate({ ...audit, auditSha: 'older-head' })).toBe(false);
    expect(runtime.validateCandidate({ ...audit, auditProvider: 'codex' })).toBe(false);
    expect(() => new OrchestratorRuntime('claude', 'claude-opus-5-5')).toThrow(
      'not valid for provider claude',
    );
  });

  it('refuses a provider handoff while leases are active and allows it after completion', () => {
    const runtime = new OrchestratorRuntime();
    runtime.register([task('a')]);
    const lease = runtime.acquire('a', 'agent-a', 'C:/wt/a', 'base', 0);
    expect(() => runtime.handoff('claude')).toThrow('leases are active');
    runtime.complete('a', lease.fencing, 'head', 1, 'event-a');
    runtime.handoff('claude');
    expect(runtime.snapshot()).toMatchObject({ provider: 'claude', epoch: 2 });
  });

  it('renews a live lease and rejects stale or expired renewals', () => {
    const runtime = new OrchestratorRuntime();
    runtime.register([task('a')]);
    const lease = runtime.acquire('a', 'agent-a', 'C:/wt/a', 'base', 0, 10);
    expect(runtime.renew('a', lease.fencing, 5, 100).expiresAt).toBe(105);
    expect(() => runtime.renew('a', lease.fencing + 1, 6)).toThrow('stale fencing');
    expect(() => runtime.renew('missing', 1, 6)).toThrow('stale fencing');
    expect(() => runtime.renew('a', lease.fencing, 200)).toThrow('lease expired');
  });

  it('requires two distinct approving gate auditors on the completed candidate', () => {
    const runtime = new OrchestratorRuntime();
    runtime.register([task('a')]);
    const lease = runtime.acquire('a', 'agent-a', 'C:/wt/a', 'base', 0);
    runtime.complete('a', lease.fencing, 'head-a', 1, 'event-a');
    const evidenceA = [evidence('a', 'head-a')];
    expect(() => runtime.setGate(0, 'passed', evidenceA)).toThrow('two independent');
    expect(() => runtime.setGate(0, 'passed', evidenceA, audits('head-a', 1))).toThrow(
      'two independent',
    );
    const duplicated = audits('head-a').map((audit) => ({ ...audit, auditorId: 'same' }));
    expect(() => runtime.setGate(0, 'passed', evidenceA, duplicated)).toThrow('two independent');
    expect(() => runtime.setGate(0, 'passed', evidenceA, audits('other-sha'))).toThrow(
      'two independent',
    );
    const wrongModel = audits('head-a').map((audit) => ({
      ...audit,
      observedModel: 'claude-opus-5-5' as Model,
    }));
    expect(() => runtime.setGate(0, 'passed', evidenceA, wrongModel)).toThrow('two independent');
    const rejecting = audits('head-a');
    rejecting[1] = { ...rejecting[1]!, verdict: 'request_changes' };
    expect(() => runtime.setGate(0, 'passed', evidenceA, rejecting)).toThrow('requested changes');
    runtime.setGate(0, 'passed', evidenceA, audits('head-a'));
    expect(runtime.snapshot().gates[0]).toBe('passed');
  });

  it('keeps gates cumulative when an earlier gate fails or is reopened', () => {
    const runtime = new OrchestratorRuntime();
    runtime.register([task('a', 0), task('b', 1), task('c', 2)]);
    const first = runtime.acquire('a', 'agent-a', 'C:/wt/a', 'base', 0);
    runtime.complete('a', first.fencing, 'head-a', 1, 'event-a');
    runtime.setGate(0, 'passed', [evidence('a', 'head-a')], audits('head-a'));
    const second = runtime.acquire('b', 'agent-b', 'C:/wt/b', 'base', 1);
    runtime.complete('b', second.fencing, 'head-b', 2, 'event-b');
    runtime.setGate(1, 'passed', [evidence('b', 'head-b')], audits('head-b'));
    runtime.setGate(0, 'failed');
    expect(runtime.snapshot().gates).toMatchObject({ 0: 'failed', 1: 'pending' });
    expect(() => runtime.acquire('c', 'agent-c', 'C:/wt/c', 'base', 2)).toThrow(
      'blocked by gate 0',
    );

    const reopen = new OrchestratorRuntime();
    reopen.register([task('a', 0)]);
    const lease = reopen.acquire('a', 'agent-a', 'C:/wt/a', 'base', 0);
    reopen.complete('a', lease.fencing, 'head-a', 1, 'event-a');
    reopen.setGate(0, 'passed', [evidence('a', 'head-a')], audits('head-a'));
    reopen.register([{ ...task('late', 0) }]);
    expect(reopen.snapshot().gates[0]).toBe('pending');
  });

  it('does not pass an empty stage and rejects inconsistent snapshots', () => {
    const runtime = new OrchestratorRuntime();
    runtime.register([task('a', 1)]);
    expect(() => runtime.setGate(0, 'passed', [])).toThrow('has no tasks');
    const snapshot = runtime.snapshot();
    expect(() =>
      OrchestratorRuntime.restore({ ...snapshot, gates: { 0: 'passed', 1: 'pending' } }),
    ).toThrow('without completed tasks');
    expect(() =>
      OrchestratorRuntime.restore({
        ...snapshot,
        tasks: snapshot.tasks.map((item) => ({ ...item, status: 'completed' as const })),
        gates: { 1: 'passed' },
      }),
    ).toThrow('before gate 0');
  });
});
