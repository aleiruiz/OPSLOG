import { describe, expect, it } from 'vitest';
import {
  INCIDENT_COMMANDS,
  INCIDENT_STATUSES,
  IncidentError,
  TERMINAL_STATUSES,
  type IncidentCommand,
  type IncidentStatus,
} from '../../cases/src/index.js';
import {
  IDEMPOTENCY_REQUIRED_COMMANDS,
  TRANSITIONS,
  routeAllows,
  transitionAllowed,
} from './commands.js';
import {
  ADMIN,
  FULL,
  MANAGER,
  TENANT_A,
  draft,
  put,
  resolvedFrom,
  setup,
  type World,
} from './test-support.js';

/** SPECS §6.2, written out independently of the code under test (the oracle of the matrix). */
const OPEN: readonly IncidentStatus[] = [
  'draft',
  'reported',
  'under_review',
  'insurance_process',
  'insurance_rejected',
  'no_insurance',
  'repair',
  'resolved',
  'reopened',
];
const ORACLE: Readonly<
  Record<IncidentCommand, { from: readonly IncidentStatus[]; to: IncidentStatus | null }>
> = {
  report: { from: ['draft'], to: 'reported' },
  assign: { from: OPEN.filter((s) => s !== 'draft'), to: null },
  review: { from: ['reported', 'reopened'], to: 'under_review' },
  insure: { from: ['under_review'], to: 'insurance_process' },
  no_insurance: { from: ['under_review'], to: 'no_insurance' },
  reject: { from: ['insurance_process'], to: 'insurance_rejected' },
  appeal: { from: ['insurance_rejected'], to: 'insurance_process' },
  approve_assumption: { from: ['insurance_rejected'], to: null },
  repair: {
    from: ['under_review', 'no_insurance', 'insurance_process', 'insurance_rejected', 'reopened'],
    to: 'repair',
  },
  resolve: {
    from: ['under_review', 'no_insurance', 'insurance_process', 'insurance_rejected', 'repair'],
    to: 'resolved',
  },
  approve_close: { from: ['resolved'], to: null },
  close: { from: ['resolved'], to: 'closed' },
  reopen: { from: ['closed'], to: 'reopened' },
  cancel: { from: OPEN, to: 'cancelled' },
};
/** A world with a case in `status` that meets every requirement of `command`. */
async function cell(command: IncidentCommand, status: IncidentStatus) {
  const world = setup();
  const created = await draft(world, { type: 'other' });
  const incident = await put(
    world,
    created,
    { ...FULL, status },
    status === 'resolved' ? [resolvedFrom('under_review')] : [],
  );
  // The approvals only exist where a threshold does.
  if (command === 'approve_assumption' || command === 'approve_close')
    world.settings.threshold = { amountMinor: '500000', currency: 'MXN' };
  for (const category of [
    'photo',
    'police_report',
    'rejection_letter',
    'budget',
    'invoice',
  ] as const)
    world.evidence.add(category);
  world.evidence.add('other', true, 'post_repair');
  if (command === 'resolve')
    world.repairs.snapshot = {
      available: true,
      orders: [{ orderId: 'o1', status: 'completed', version: 1, hasCosts: true }],
    };
  world.costs.costs = { available: true, hasCosts: command !== 'cancel', hasRepairLine: true };
  return { world, incident };
}

const body = (command: IncidentCommand, version: number) => ({
  command,
  version,
  ...(command === 'assign' ? { responsibleId: MANAGER.subject } : {}),
  ...(command === 'cancel' || command === 'reopen' ? { reason: 'Motivo sintético' } : {}),
});

const snapshotOf = async (world: World, id: string) =>
  JSON.stringify([
    await world.store.get(TENANT_A, id),
    await world.store.history(TENANT_A, id),
    world.store.events,
    world.store.audit,
  ]);

/** What running the command in the state does: the new status, or the error code. */
async function outcome(command: IncidentCommand, status: IncidentStatus): Promise<string> {
  const { world, incident } = await cell(command, status);
  const before = await snapshotOf(world, incident.id);
  try {
    const next = await world.workflow.execute(
      TENANT_A,
      ADMIN,
      incident.id,
      body(command, incident.version + 0),
      `key-${command}-${status}`,
    );
    return `ok:${next.status}`;
  } catch (error) {
    if (!(error instanceof IncidentError)) throw error;
    // A refusal leaves no effect at all: no row, no timeline, no audit, no event.
    expect(await snapshotOf(world, incident.id)).toBe(before);
    return error.code;
  }
}

const expected = (command: IncidentCommand, status: IncidentStatus): string => {
  const rule = ORACLE[command];
  return rule.from.includes(status) ? `ok:${rule.to ?? status}` : 'invalid_transition';
};

describe('the transition table (case 1)', () => {
  it('has the 14 commands, the 11 states and exactly the oracle rows', () => {
    expect(INCIDENT_COMMANDS).toHaveLength(14);
    expect(INCIDENT_STATUSES).toHaveLength(11);
    for (const command of INCIDENT_COMMANDS) {
      expect(TRANSITIONS[command].from, command).toEqual(ORACLE[command].from);
      expect(TRANSITIONS[command].to, command).toBe(ORACLE[command].to);
    }
    expect([...IDEMPOTENCY_REQUIRED_COMMANDS].sort()).toEqual(
      ['approve_assumption', 'approve_close', 'close', 'reopen'].sort(),
    );
    expect(TRANSITIONS.close.from).not.toContain('closed');
    for (const terminal of ['closed', 'cancelled'] as const)
      for (const command of INCIDENT_COMMANDS)
        if (command !== 'reopen') expect(TRANSITIONS[command].from).not.toContain(terminal);
  });

  it('lets every allowed pair through with complete requirements and refuses all others with 409 and no effect', async () => {
    for (const command of INCIDENT_COMMANDS)
      for (const status of INCIDENT_STATUSES)
        expect(await outcome(command, status), `${command} from ${status}`).toBe(
          expected(command, status),
        );
  }, 120_000);

  it('catches a directed mutation of any cell of the transition map', async () => {
    const original = { ...TRANSITIONS };
    try {
      for (const command of INCIDENT_COMMANDS)
        for (const status of INCIDENT_STATUSES) {
          const rule = original[command];
          const flipped = rule.from.includes(status)
            ? rule.from.filter((from) => from !== status)
            : [...rule.from, status];
          (TRANSITIONS as Record<string, unknown>)[command] = { ...rule, from: flipped };
          const mutated = await outcome(command, status);
          // Closed and cancelled stay locked by their own guard even if the map were wrong there.
          if (TERMINAL_STATUSES.includes(status)) expect(mutated).toBe('invalid_transition');
          else
            expect(mutated, `mutated ${command} from ${status}`).not.toBe(
              expected(command, status),
            );
          (TRANSITIONS as Record<string, unknown>)[command] = rule;
        }
    } finally {
      Object.assign(TRANSITIONS, original);
    }
  }, 120_000);
});

describe('the route of each type (case 6)', () => {
  it('lets a direct route go from review to resolved and repair only where the type allows', () => {
    expect(routeAllows('resolve', 'under_review', 'traffic_violation')).toBe(true);
    expect(routeAllows('repair', 'under_review', 'traffic_violation')).toBe(false);
    expect(routeAllows('resolve', 'under_review', 'collision')).toBe(false);
    expect(routeAllows('repair', 'under_review', 'collision')).toBe(false);
    expect(routeAllows('repair', 'no_insurance', 'collision')).toBe(true);
    expect(routeAllows('repair', 'under_review', 'parking_damage')).toBe(true);
    for (const status of ['under_review', 'no_insurance', 'insurance_process'] as const)
      expect(routeAllows('repair', status, 'theft_total'), status).toBe(false);
    expect(routeAllows('resolve', 'insurance_process', 'theft_total')).toBe(true);
    expect(routeAllows('report', 'draft', 'collision')).toBe(true);
  });

  it('reads the table, the route and the delivery together', async () => {
    const world = setup();
    const created = await draft(world, { type: 'collision' });
    const underReview = await put(world, created, { status: 'under_review' });
    expect(transitionAllowed(underReview, 'review')).toBe(false);
    expect(transitionAllowed(underReview, 'repair')).toBe(false);
    expect(transitionAllowed(underReview, 'insure')).toBe(true);
    expect(transitionAllowed({ ...underReview, status: 'resolved' }, 'close')).toBe(true);
  });
});
