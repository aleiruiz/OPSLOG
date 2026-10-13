import { describe, expect, it } from 'vitest';
import type { Incident } from '../../cases/src/index.js';
import { dueAlerts, evaluate } from './evaluate.js';
import type { CycleFacts } from './types.js';
import { DAY, DEFAULT_SETTINGS, HOUR, MEXICO, REPORTED_AT, at } from './test-support.js';

const facts = (over: Partial<CycleFacts> = {}): CycleFacts => ({
  cycle: 1,
  startedAt: REPORTED_AT,
  severity: 'high',
  targetDays: 15,
  targetVersion: 1,
  resolvedAt: null,
  pending: null,
  ...over,
});
const incident = (over: Partial<Incident> = {}): Incident =>
  ({
    id: 'inc-1',
    tenantId: 'tenant-a',
    status: 'under_review',
    cycle: 1,
    reportedAt: REPORTED_AT,
    updatedAt: REPORTED_AT,
    responsibleId: 'user-x',
    ...over,
  }) as Incident;
const ms = (offset: number) => at(REPORTED_AT, offset).getTime();
const kinds = (list: readonly { kind: string }[]) => list.map((a) => a.kind);

describe('evaluate', () => {
  it('judges the 80 % and 100 % marks to the millisecond', () => {
    const day12 = 12 * DAY;
    expect(evaluate(facts(), MEXICO, ms(day12 - 1)).state).toBe('on_track');
    expect(evaluate(facts(), MEXICO, ms(day12)).state).toBe('warning');
    expect(evaluate(facts(), MEXICO, ms(15 * DAY - 1)).state).toBe('warning');
    expect(evaluate(facts(), MEXICO, ms(15 * DAY)).state).toBe('breached');
    expect(evaluate(facts(), MEXICO, ms(0)).elapsedPercent).toBe(0);
    expect(evaluate(facts(), MEXICO, ms(day12)).elapsedPercent).toBe(80);
    expect(evaluate(facts(), MEXICO, ms(30 * DAY)).elapsedPercent).toBe(200);
    expect(evaluate(facts(), MEXICO, ms(-DAY)).elapsedPercent).toBe(0);
    expect(evaluate(facts(), MEXICO, ms(0)).deadline).toBe('2026-11-16T16:00:00.000Z');
  });

  it('freezes a resolved cycle at its resolution and says met or missed', () => {
    const early = facts({ resolvedAt: at(REPORTED_AT, 10 * DAY).toISOString() });
    expect(evaluate(early, MEXICO, ms(40 * DAY))).toMatchObject({
      state: 'met',
      elapsedPercent: 66,
    });
    const exact = facts({ resolvedAt: at(REPORTED_AT, 15 * DAY).toISOString() });
    expect(evaluate(exact, MEXICO, ms(40 * DAY)).state).toBe('met');
    const late = facts({ resolvedAt: at(REPORTED_AT, 15 * DAY + 1).toISOString() });
    expect(evaluate(late, MEXICO, ms(40 * DAY)).state).toBe('missed');
  });
});

describe('dueAlerts', () => {
  const due = (over: Partial<Incident>, offset: number, f: CycleFacts | null = facts()) =>
    dueAlerts(
      incident({ updatedAt: at(REPORTED_AT, offset).toISOString(), ...over }),
      f,
      DEFAULT_SETTINGS,
      ms(offset),
    );

  it('asks for the SLA notices once their threshold is reached, both when first seen late', () => {
    expect(kinds(due({}, 12 * DAY - 1000))).toEqual([]);
    expect(due({}, 12 * DAY)).toEqual([
      { kind: 'sla_warning', cycle: 1, dedupeRef: 't1', deadline: '2026-11-16T16:00:00.000Z' },
    ]);
    expect(kinds(due({}, 15 * DAY))).toEqual(['sla_warning', 'sla_breach']);
    expect(kinds(due({}, 40 * DAY, facts({ targetVersion: 3 })))).toEqual([
      'sla_warning',
      'sla_breach',
    ]);
    expect(due({}, 40 * DAY, facts({ targetVersion: 3 }))[0]?.dedupeRef).toBe('t3');
  });

  it('asks for no SLA notice for a resolved cycle or one that never started', () => {
    const resolved = facts({ resolvedAt: at(REPORTED_AT, DAY).toISOString() });
    expect(kinds(due({}, 40 * DAY, resolved))).toEqual([]);
    expect(kinds(due({}, 40 * DAY, null))).toEqual([]);
  });

  it('measures the case without a responsible in wall-clock hours, strictly over 4 h', () => {
    const open = { status: 'reported', responsibleId: null } as const;
    expect(kinds(due(open, 4 * HOUR))).toEqual([]);
    expect(kinds(due(open, 4 * HOUR + 1000))).toEqual(['unassigned']);
    expect(kinds(due(open, 24 * HOUR - 1))).toEqual(['unassigned']);
    expect(kinds(due(open, 24 * HOUR))).toEqual(['unassigned', 'unassigned_escalation']);
    expect(due(open, 5 * HOUR)[0]?.dedupeRef).toBe(`r${Date.parse(REPORTED_AT)}`);
    // Assigned in time, or past `reported`, no notice.
    expect(kinds(due({ status: 'reported', responsibleId: 'user-x' }, 30 * HOUR))).toEqual([]);
    expect(kinds(due({ status: 'under_review', responsibleId: null }, 30 * HOUR))).toEqual([]);
  });

  it('flags a quiet case after N days and escalates at 2N, referenced on the last change', () => {
    const quiet = (days: number) =>
      dueAlerts(incident({ updatedAt: REPORTED_AT }), null, DEFAULT_SETTINGS, ms(days * DAY));
    expect(kinds(quiet(5 - 1 / 86_400))).toEqual([]);
    expect(kinds(quiet(5))).toEqual(['inactive']);
    expect(kinds(quiet(10 - 1 / 86_400))).toEqual(['inactive']);
    expect(kinds(quiet(10))).toEqual(['inactive', 'inactive_escalation']);
    expect(quiet(5)[0]?.dedupeRef).toBe(`u${Date.parse(REPORTED_AT)}`);
    const custom = dueAlerts(incident(), null, { ...DEFAULT_SETTINGS, inactivityDays: 1 }, ms(DAY));
    expect(kinds(custom)).toEqual(['inactive']);
  });
});
