import { describe, expect, it } from 'vitest';
import type { Incident } from '../../cases/src/index.js';
import { DEFAULT_SETTINGS } from './test-support.js';
import { cycleFacts } from './cycles.js';
import type { CycleRow } from './types.js';

const STARTED = '2026-11-01T16:00:00.000Z';
const row = {
  cycle: 1,
  startedAt: STARTED,
  severity: 'low',
  targetDays: 30,
  targetVersion: 1,
} as unknown as CycleRow;
const incident = (resolvedAt: string | null) =>
  ({
    cycle: 1,
    severity: 'critical',
    reportedAt: STARTED,
    resolvedAt,
  }) as unknown as Incident;
const history = async () => [];

describe('retarget of a cycle', () => {
  it('applies a changed severity to a cycle that is still running', async () => {
    const facts = await cycleFacts(incident(null), 1, [row], DEFAULT_SETTINGS, history);
    expect(facts).toMatchObject({ severity: 'critical', targetVersion: 2, pending: 'retarget' });
  });

  it('keeps the target of a cycle that is already resolved', async () => {
    const facts = await cycleFacts(
      incident('2026-11-03T16:00:00.000Z'),
      1,
      [row],
      DEFAULT_SETTINGS,
      history,
    );
    expect(facts).toMatchObject({
      severity: 'low',
      targetDays: 30,
      targetVersion: 1,
      pending: null,
    });
  });
});
